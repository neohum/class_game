/**
 * runtime.ts — Shared knowledge runtime management, platform detection,
 * runtime doctor, and setup helper for the harness knowledge library.
 *
 * Enforces zero-unintended-dependency rule:
 * - Dynamic imports are strictly guarded.
 * - Missing dependencies/models are reported as clean doctor statuses with
 *   actionable instructions; never auto-installed during regular execution.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeModelFingerprint,
  validateEmbeddingProfile,
  ModelCompatibilityError,
  type EmbeddingProfile,
} from "./contracts.ts";

// ============================================================================
// Types and Specifications
// ============================================================================

export interface BinaryPlatformSpec {
  os: string;
  arch: string;
  backend: "vulkan" | "metal" | "cpu";
  asset_name: string;
  url: string;
  sha256: string;
}

export interface OptionalPackageSpec {
  version: string;
  purpose: string;
  import_path: string;
}

export interface RuntimeLock {
  version: number;
  embedding_profile: EmbeddingProfile & {
    file_name: string;
    download_url?: string;
    approx_size_bytes?: number;
    normalization_algorithm?: string;
  };
  runtime_binaries: {
    version: string;
    commit: string;
    release_tag: string;
    platforms: Record<string, BinaryPlatformSpec>;
  };
  optional_packages: Record<string, OptionalPackageSpec>;
  runtime_limits: {
    min_node_version: string;
    batch_size_limit: number;
    min_disk_free_bytes: number;
    default_server_host: string;
    default_server_port: number;
    default_server_timeout_ms: number;
  };
}

export interface KnowledgePaths {
  root: string;
  runtime: string;
  models: string;
  bin: string;
  runtimeModules: string;
  producer: string;
  producerJobs: string;
  producerDb: string;
  snapshots: string;
  config: string;
  modelFile: string;
}

export interface PlatformAccelerationReport {
  available: boolean;
  backend: "vulkan" | "metal" | "cpu";
  details: string;
  gpuFailed?: boolean;
  fallbackReason?: string;
}

export interface ModelFileCheckReport {
  installed: boolean;
  path: string;
  expected_sha256: string;
  actual_sha256?: string;
  valid: boolean;
  size_bytes?: number;
  message?: string;
}

export interface DiskSpaceReport {
  ok: boolean;
  free_bytes: number;
  required_bytes: number;
  message?: string;
}

export interface OptionalPackageReport {
  installed: boolean;
  version?: string;
  required_version: string;
  purpose: string;
  error?: string;
}

export interface RuntimeDoctorReport {
  ok: boolean;
  knowledge_home: string;
  platform: NodeJS.Platform;
  arch: string;
  node_version: string;
  node_version_ok: boolean;
  acceleration: PlatformAccelerationReport;
  model: ModelFileCheckReport;
  disk_space: DiskSpaceReport;
  optional_packages: Record<string, OptionalPackageReport>;
  actionable_instructions: string[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  knowledgeHome?: string;
  lock?: RuntimeLock;
  skipModelHashCheck?: boolean;
}

export interface SetupOptions {
  knowledgeHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  dryRun?: boolean;
  installReleaseCode?: boolean;
  sourceReleaseDir?: string;
}

export interface SetupResult {
  ok: boolean;
  knowledge_home: string;
  directories_created: string[];
  release_code_staged?: string;
  doctor: RuntimeDoctorReport;
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Determines HARNESS_KNOWLEDGE_HOME directory based on platform and environment.
 * Priority:
 * 1. env.HARNESS_KNOWLEDGE_HOME
 * 2. win32:
 *    - if env.HARNESS_KNOWLEDGE_ROLE === "producer" or env.HARNESS_PRODUCER === "true":
 *      E:\harness-knowledge (or env.HARNESS_KNOWLEDGE_PRODUCER_DIR)
 *    - else standard: %LOCALAPPDATA%\create-agent-harness\knowledge
 * 3. darwin: ~/Library/Application Support/create-agent-harness/knowledge
 * 4. linux: $XDG_DATA_HOME/create-agent-harness/knowledge or ~/.local/share/create-agent-harness/knowledge
 */
export function getKnowledgeHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env.HARNESS_KNOWLEDGE_HOME?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  if (platform === "win32") {
    const isProducer =
      env.HARNESS_KNOWLEDGE_ROLE?.toLowerCase() === "producer" ||
      env.HARNESS_PRODUCER === "true" ||
      env.HARNESS_PRODUCER === "1";

    if (isProducer) {
      const producerDir = env.HARNESS_KNOWLEDGE_PRODUCER_DIR?.trim() || "E:\\harness-knowledge";
      return path.resolve(producerDir);
    }

    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.resolve(localAppData, "create-agent-harness", "knowledge");
    }

    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) {
      return path.resolve(userProfile, "AppData", "Local", "create-agent-harness", "knowledge");
    }

    return "C:\\create-agent-harness\\knowledge";
  }

  const home = env.HOME?.trim() || os.homedir();

  if (platform === "darwin") {
    return path.resolve(home, "Library", "Application Support", "create-agent-harness", "knowledge");
  }

  // linux and other POSIX
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return path.resolve(xdgDataHome, "create-agent-harness", "knowledge");
  }

  return path.resolve(home, ".local", "share", "create-agent-harness", "knowledge");
}

/**
 * Returns structured directory and file paths within HARNESS_KNOWLEDGE_HOME.
 */
export function getKnowledgePaths(
  knowledgeHome?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): KnowledgePaths {
  const root = knowledgeHome ? path.resolve(knowledgeHome) : getKnowledgeHome(env, platform);
  const runtime = path.join(root, "runtime");
  const models = path.join(runtime, "models");
  const bin = path.join(runtime, "bin");
  const runtimeModules = path.join(runtime, "node_modules");
  const producer = path.join(root, "producer");
  const producerJobs = path.join(producer, "jobs");
  const producerDb = path.join(producer, "catalog.sqlite");
  const snapshots = path.join(root, "snapshots");
  const config = path.join(root, "config.json");
  const modelFile = path.join(models, "qwen3-embedding-0.6b-q8_0.gguf");

  return {
    root,
    runtime,
    models,
    bin,
    runtimeModules,
    producer,
    producerJobs,
    producerDb,
    snapshots,
    config,
    modelFile,
  };
}

// ============================================================================
// Runtime Lock Loading and Validation
// ============================================================================

let cachedRuntimeLock: RuntimeLock | null = null;

/**
 * Loads and validates runtime-lock.json.
 */
export function loadRuntimeLock(customPath?: string): RuntimeLock {
  if (!customPath && cachedRuntimeLock) {
    return cachedRuntimeLock;
  }

  let lockPath = customPath;
  if (!lockPath) {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    lockPath = path.join(currentDir, "runtime-lock.json");
  }

  if (!fs.existsSync(lockPath)) {
    throw new ModelCompatibilityError(
      "MODEL_UNAVAILABLE",
      `runtime-lock.json not found at ${lockPath}`,
    );
  }

  const raw = fs.readFileSync(lockPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ModelCompatibilityError(
      "INCOMPATIBLE_VERSION",
      `Failed to parse runtime-lock.json: ${String(err)}`,
    );
  }

  const lock = parsed as RuntimeLock;

  if (!lock.embedding_profile || typeof lock.embedding_profile !== "object") {
    throw new ModelCompatibilityError(
      "MODEL_UNAVAILABLE",
      "runtime-lock.json missing 'embedding_profile'",
    );
  }

  // Validate the embedding profile using contracts validator
  const validatedProfile = validateEmbeddingProfile(lock.embedding_profile);

  // Verify computed fingerprint matches
  const computedFingerprint = computeModelFingerprint(validatedProfile);
  if (lock.embedding_profile.fingerprint.toLowerCase() !== computedFingerprint) {
    throw new ModelCompatibilityError(
      "MODEL_FINGERPRINT_MISMATCH",
      `Fingerprint in runtime-lock.json (${lock.embedding_profile.fingerprint}) does not match computed (${computedFingerprint})`,
    );
  }

  if (!lock.optional_packages || typeof lock.optional_packages !== "object") {
    throw new ModelCompatibilityError(
      "INCOMPATIBLE_VERSION",
      "runtime-lock.json missing 'optional_packages'",
    );
  }

  if (!customPath) {
    cachedRuntimeLock = lock;
  }

  return lock;
}

// ============================================================================
// Platform Acceleration and Hardware Doctor
// ============================================================================

/**
 * Detects hardware acceleration availability (Vulkan for Windows, Metal for macOS Apple Silicon, CPU fallback).
 */
export async function detectPlatformAcceleration(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformAccelerationReport> {
  // If user explicitly configured CPU mode
  if (env.HARNESS_EMBEDDING_BACKEND === "cpu") {
    return {
      available: false,
      backend: "cpu",
      details: "Configured via HARNESS_EMBEDDING_BACKEND=cpu override",
    };
  }

  if (platform === "win32") {
    // Check Vulkan availability on Windows
    // Typically vulkan-1.dll exists in system32
    const sysRoot = env.SystemRoot || "C:\\Windows";
    const vulkanDll = path.join(sysRoot, "System32", "vulkan-1.dll");

    try {
      if (fs.existsSync(vulkanDll)) {
        return {
          available: true,
          backend: "vulkan",
          details: `Windows Vulkan loader detected at ${vulkanDll}`,
        };
      }
    } catch {
      // Ignore check errors
    }

    return {
      available: false,
      backend: "cpu",
      details: "Vulkan loader (vulkan-1.dll) not found in System32; CPU fallback will be used",
      gpuFailed: true,
      fallbackReason: "vulkan-1.dll not found in System32",
    };
  }

  if (platform === "darwin") {
    if (arch === "arm64") {
      return {
        available: true,
        backend: "metal",
        details: "macOS Apple Silicon (arm64) Metal acceleration natively supported",
      };
    }
    return {
      available: false,
      backend: "cpu",
      details: "macOS Intel (x64); CPU fallback will be used",
      gpuFailed: false,
      fallbackReason: "Intel macOS does not use Metal runner",
    };
  }

  // Linux or others
  return {
    available: false,
    backend: "cpu",
    details: "Linux default CPU execution mode",
  };
}

// ============================================================================
// Model File Integrity and Disk Space Verification
// ============================================================================

/**
 * Validates existence, size, and SHA-256 hash of the local embedding model file.
 */
export async function checkModelFile(
  modelPath: string,
  expectedSha256: string,
  skipHashCheck = false,
): Promise<ModelFileCheckReport> {
  try {
    const stats = await fsPromises.stat(modelPath);
    if (!stats.isFile()) {
      return {
        installed: false,
        path: modelPath,
        expected_sha256: expectedSha256,
        valid: false,
        message: `Path is not a regular file: ${modelPath}`,
      };
    }

    if (skipHashCheck) {
      return {
        installed: true,
        path: modelPath,
        expected_sha256: expectedSha256,
        valid: true,
        size_bytes: stats.size,
        message: "Model file exists (hash check skipped)",
      };
    }

    // Stream SHA-256 calculation
    const hash = createHash("sha256");
    const stream = fs.createReadStream(modelPath);

    const actualSha256 = await new Promise<string>((resolve, reject) => {
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", (err) => reject(err));
      stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
    });

    const matches = actualSha256 === expectedSha256.toLowerCase();
    return {
      installed: true,
      path: modelPath,
      expected_sha256: expectedSha256.toLowerCase(),
      actual_sha256: actualSha256,
      valid: matches,
      size_bytes: stats.size,
      message: matches
        ? "Model file verified with correct SHA-256"
        : `Model file SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    };
  } catch (err) {
    return {
      installed: false,
      path: modelPath,
      expected_sha256: expectedSha256,
      valid: false,
      message: `Model file not found or inaccessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Checks free disk space at the target directory against the required byte threshold.
 */
export async function checkDiskSpace(
  targetDir: string,
  requiredBytes: number,
): Promise<DiskSpaceReport> {
  // Find an existing ancestor directory if targetDir doesn't exist yet
  let probeDir = targetDir;
  while (!fs.existsSync(probeDir)) {
    const parent = path.dirname(probeDir);
    if (parent === probeDir) break;
    probeDir = parent;
  }

  try {
    if (typeof fsPromises.statfs === "function") {
      const stats = await fsPromises.statfs(probeDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const ok = freeBytes >= requiredBytes;
      return {
        ok,
        free_bytes: freeBytes,
        required_bytes: requiredBytes,
        message: ok
          ? `Adequate disk space: ${(freeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB available`
          : `Low disk space: ${(freeBytes / (1024 * 1024)).toFixed(1)} MB available, ${(requiredBytes / (1024 * 1024)).toFixed(1)} MB required`,
      };
    }
  } catch (err) {
    // If statfs fails or is unsupported on some network filesystems
    return {
      ok: true,
      free_bytes: 0,
      required_bytes: requiredBytes,
      message: `statfs probe skipped or unsupported: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    free_bytes: 0,
    required_bytes: requiredBytes,
    message: "statfs not available in this runtime",
  };
}

// ============================================================================
// Guarded Dynamic Package Checks
// ============================================================================

/**
 * Checks if an optional npm package is available in the current environment or runtime directory.
 * NEVER throws an unhandled error; NEVER auto-installs during regular execution.
 */
export async function checkOptionalPackage(
  packageName: string,
  runtimeModulesDir?: string,
): Promise<{ installed: boolean; version?: string; error?: string }> {
  // Guarded dynamic import
  try {
    const mod = await import(packageName);
    let version: string | undefined;
    if (mod && typeof mod === "object") {
      if ("version" in mod && typeof mod.version === "string") {
        version = mod.version;
      }
    }
    return { installed: true, version };
  } catch (err: unknown) {
    // If not found in standard resolution, check in custom runtimeModulesDir
    if (runtimeModulesDir) {
      try {
        const pkgJsonPath = path.join(runtimeModulesDir, packageName, "package.json");
        if (fs.existsSync(pkgJsonPath)) {
          const raw = await fsPromises.readFile(pkgJsonPath, "utf-8");
          const parsed = JSON.parse(raw);
          return { installed: true, version: parsed.version };
        }
      } catch {
        // Ignore fallback read error
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, error: message };
  }
}

// ============================================================================
// Runtime Doctor
// ============================================================================

/**
 * Runs a complete diagnostic of the knowledge library runtime environment.
 * Validates Node version, platform acceleration, model presence & hash,
 * disk space, and optional packages.
 */
export async function checkRuntimeDoctor(
  options: DoctorOptions = {},
): Promise<RuntimeDoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const lock = options.lock ?? loadRuntimeLock();
  const paths = getKnowledgePaths(options.knowledgeHome, env, platform);

  // Check Node version >= min_node_version (default 22.18.0)
  const currentVersion = process.versions.node;
  const minVersion = lock.runtime_limits.min_node_version;
  const nodeVersionOk = compareSemver(currentVersion, minVersion) >= 0;

  // Check acceleration
  const acceleration = await detectPlatformAcceleration(platform, arch, env);

  // Check model file
  const model = await checkModelFile(
    paths.modelFile,
    lock.embedding_profile.sha256,
    options.skipModelHashCheck ?? false,
  );

  // Check disk space
  const diskSpace = await checkDiskSpace(paths.root, lock.runtime_limits.min_disk_free_bytes);

  // Check optional packages
  const optionalPackages: Record<string, OptionalPackageReport> = {};
  for (const [pkgName, spec] of Object.entries(lock.optional_packages)) {
    const res = await checkOptionalPackage(spec.import_path, paths.runtimeModules);
    optionalPackages[pkgName] = {
      installed: res.installed,
      version: res.version,
      required_version: spec.version,
      purpose: spec.purpose,
      error: res.error,
    };
  }

  // Generate actionable instructions
  const instructions: string[] = [];

  if (!nodeVersionOk) {
    instructions.push(
      `Upgrade Node.js to >= ${minVersion} (current: ${currentVersion}) for required built-in features.`,
    );
  }

  if (!model.installed || !model.valid) {
    const downloadUrl = lock.embedding_profile.download_url || "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF";
    instructions.push(
      `Download embedding model '${lock.embedding_profile.file_name}' to '${paths.models}'. Source: ${downloadUrl}`,
    );
  }

  if (!diskSpace.ok) {
    instructions.push(
      `Free up disk space on '${paths.root}'. Available: ${(diskSpace.free_bytes / (1024 * 1024)).toFixed(0)} MB, Required: ${(diskSpace.required_bytes / (1024 * 1024)).toFixed(0)} MB`,
    );
  }

  if (!optionalPackages["sqlite-vec"]?.installed) {
    instructions.push(
      `Optional: Install 'sqlite-vec@${lock.optional_packages["sqlite-vec"]?.version || "0.1.6"}' for vector index acceleration. Reader works in lexical/FTS mode without it.`,
    );
  }

  if (!optionalPackages["@aws-sdk/client-s3"]?.installed) {
    instructions.push(
      `Optional: Install '@aws-sdk/client-s3@${lock.optional_packages["@aws-sdk/client-s3"]?.version || "3.750.0"}' for Cloudflare R2 cloud sync. Local snapshots work without it.`,
    );
  }

  // Overall ok status
  // Note: optional packages missing do not fail runtime doctor; only missing critical node version or disk failure
  const ok = nodeVersionOk && diskSpace.ok;

  return {
    ok,
    knowledge_home: paths.root,
    platform,
    arch,
    node_version: currentVersion,
    node_version_ok: nodeVersionOk,
    acceleration,
    model,
    disk_space: diskSpace,
    optional_packages: optionalPackages,
    actionable_instructions: instructions,
  };
}

// ============================================================================
// Setup Helper
// ============================================================================

/**
 * Initializes directory structure and stages verified execution code in HARNESS_KNOWLEDGE_HOME.
 * AC-5: "setup은 검증한 harness release의 생산자 실행 코드도 공용 runtime에 고정 설치한다.
 * scheduler는 이 경로를 사용하고 URL clone의 자동 갱신으로 실행 코드가 바뀌지 않는다."
 */
export async function setupKnowledgeRuntime(
  options: SetupOptions = {},
): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const paths = getKnowledgePaths(options.knowledgeHome, env, platform);
  const directoriesCreated: string[] = [];

  const targetDirs = [
    paths.root,
    paths.runtime,
    paths.models,
    paths.bin,
    paths.runtimeModules,
    paths.producer,
    paths.producerJobs,
    paths.snapshots,
  ];

  if (!options.dryRun) {
    for (const dir of targetDirs) {
      if (!fs.existsSync(dir)) {
        await fsPromises.mkdir(dir, { recursive: true });
        directoriesCreated.push(dir);
      }
    }
  }

  let releaseCodeStaged: string | undefined;

  // Staging release code into runtime/lib if requested
  if (options.installReleaseCode && !options.dryRun) {
    const targetLib = path.join(paths.runtime, "lib");
    await fsPromises.mkdir(targetLib, { recursive: true });

    const sourceDir =
      options.sourceReleaseDir ?? path.dirname(fileURLToPath(import.meta.url));

    const filesToCopy = ["contracts.ts", "runtime.ts", "embedding.ts", "runtime-lock.json"];
    for (const f of filesToCopy) {
      const src = path.join(sourceDir, f);
      const dest = path.join(targetLib, f);
      if (fs.existsSync(src)) {
        await fsPromises.copyFile(src, dest);
      }
    }
    releaseCodeStaged = targetLib;
  }

  // Write default config.json if not present
  if (!options.dryRun && !fs.existsSync(paths.config)) {
    const defaultConfig = {
      version: 1,
      created_at: new Date().toISOString(),
      knowledge_home: paths.root,
      default_catalog_id: "shared-tools-catalog",
    };
    await fsPromises.writeFile(paths.config, JSON.stringify(defaultConfig, null, 2), "utf-8");
  }

  const doctor = await checkRuntimeDoctor({
    env,
    platform,
    arch,
    knowledgeHome: paths.root,
    skipModelHashCheck: true,
  });

  return {
    ok: doctor.ok,
    knowledge_home: paths.root,
    directories_created: directoriesCreated,
    release_code_staged: releaseCodeStaged,
    doctor,
  };
}

// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Simple semver comparison (v1 vs v2). Returns:
 *  1 if v1 > v2
 *  0 if v1 === v2
 * -1 if v1 < v2
 */
function compareSemver(v1: string, v2: string): number {
  const clean1 = v1.replace(/^v/, "").split("-")[0] || "0";
  const clean2 = v2.replace(/^v/, "").split("-")[0] || "0";

  const p1 = clean1.split(".").map(Number);
  const p2 = clean2.split(".").map(Number);

  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = p1[i] ?? 0;
    const n2 = p2[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}
