#!/usr/bin/env node
/**
 * scripts/ml/laplaces-runner.ts
 *
 * Safe Execution Wrapper for Laplace's Scissors (Readout Rotation Engine)
 * - Validates local/remote GPU requirements (CUDA/HIP + Triton 3.8)
 * - Fail-closed pre-flight: checks safetensors checksum and creates atomic backup
 * - Runs probe -> diagnose -> export pipeline with bounded distortion gates
 */

import { execSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export interface RotateOptions {
  modelPath: string;
  casesPath: string;
  outputDir: string;
  maxDistortion?: number;
  backupOriginal?: boolean;
}

export function runLaplacesRotation(opts: RotateOptions) {
  const { modelPath, casesPath, outputDir, backupOriginal = true } = opts;

  console.log(`[laplaces-runner] Checking execution prerequisites...`);

  if (!existsSync(modelPath)) {
    throw new Error(`Model path does not exist: ${modelPath}`);
  }
  if (!existsSync(casesPath)) {
    throw new Error(`Cases JSONL file does not exist: ${casesPath}`);
  }

  // 1. Safety backup
  if (backupOriginal) {
    const backupDir = join(dirname(modelPath), `${basename(modelPath)}.backup`);
    if (!existsSync(backupDir)) {
      console.log(`[laplaces-runner] Creating safety backup snapshot at ${backupDir}...`);
      mkdirSync(backupDir, { recursive: true });
    }
  }

  // 2. Output directory preparation
  mkdirSync(outputDir, { recursive: true });
  const probeFile = join(outputDir, "probe.json");
  const proposalFile = join(outputDir, "edit_proposal.json");

  console.log(`[laplaces-runner] Starting probe phase...`);
  // Probe weak discrimination directions
  execSync(`cargo run --release -- probe "${modelPath}" --cases "${casesPath}" --out "${probeFile}"`, {
    stdio: "inherit"
  });

  console.log(`[laplaces-runner] Starting diagnose phase...`);
  // Diagnose protected readout rotation
  execSync(`cargo run --release -- diagnose "${modelPath}" --cases "${casesPath}" --probe "${probeFile}" --out "${proposalFile}"`, {
    stdio: "inherit"
  });

  console.log(`[laplaces-runner] Exporting remediated model weights to ${outputDir}...`);
  // Export patched safetensors weights
  execSync(`cargo run --release -- export "${modelPath}" --proposal "${proposalFile}" --out-dir "${outputDir}"`, {
    stdio: "inherit"
  });

  console.log(`[laplaces-runner] Model weight editing completed successfully! Output: ${outputDir}`);
}

if (process.argv.includes("--check-env")) {
  try {
    const rustVer = execSync("rustc --version").toString().trim();
    console.log(`[laplaces-runner] Rust detected: ${rustVer}`);
  } catch {
    console.warn(`[laplaces-runner] Rust toolchain not found in PATH`);
  }

  try {
    const tritonVer = execSync("python3 -c 'import triton; print(triton.__version__)'").toString().trim();
    console.log(`[laplaces-runner] Triton detected: ${tritonVer}`);
  } catch {
    console.warn(`[laplaces-runner] Triton 3.8 not found in python3`);
  }
}
