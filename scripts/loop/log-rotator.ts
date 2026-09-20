import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

/**
 * Universal Log Policy
 * - Size Threshold: 10MB per file
 * - Time Cycle: Daily Midnight Rotation (Asia/Seoul / Local)
 * - Compression: Gzip (.gz) with ~90% storage savings
 * - Retention: 30 Days (General Logs) / 180 Days (Audit & Compliance)
 */
export const LOG_POLICY = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  compressRotated: true,
  generalRetentionDays: 30,
  auditRetentionDays: 180,
  inMemoryMaxEntries: 1000,
};

/**
 * Returns YYYY-MM-DD string in Asia/Seoul (KST) local time
 */
export function getKstDateString(date = new Date()): string {
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const kstTime = new Date(date.getTime() + kstOffsetMs);
  return kstTime.toISOString().slice(0, 10);
}

/**
 * Asynchronously compress a file to .gz using Gzip stream pipeline
 */
export async function gzipCompressFile(sourcePath: string): Promise<string | null> {
  if (!fs.existsSync(sourcePath)) return null;
  const dir = path.dirname(sourcePath);
  if (!fs.existsSync(dir)) return null;

  const destPath = `${sourcePath}.gz`;

  try {
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(destPath);
    const gzipStream = zlib.createGzip({ level: 9 });

    await pipeline(readStream, gzipStream, writeStream);

    // Remove uncompressed file after verified compression
    if (fs.existsSync(sourcePath)) {
      fs.unlinkSync(sourcePath);
    }

    return destPath;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`Gzip compression error for ${sourcePath}:`, err);
    }
    return null;
  }
}

/**
 * Appends a log line to a file with automatic size-based rotation check
 */
export function appendWithRotation(
  filePath: string,
  lineContent: string,
  maxSizeBytes = LOG_POLICY.maxFileSize
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. Check size and rotate if needed
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size + Buffer.byteLength(lineContent, "utf-8") >= maxSizeBytes) {
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);

        let index = 1;
        while (
          fs.existsSync(path.join(dir, `${baseName}.${index}${ext}`)) ||
          fs.existsSync(path.join(dir, `${baseName}.${index}${ext}.gz`))
        ) {
          index++;
        }

        const rotatedPath = path.join(dir, `${baseName}.${index}${ext}`);
        fs.renameSync(filePath, rotatedPath);

        if (LOG_POLICY.compressRotated) {
          gzipCompressFile(rotatedPath).catch((err) => {
            console.error(`Async gzip error for ${rotatedPath}:`, err);
          });
        }
      }
    }

    // 2. Append new line
    fs.appendFileSync(filePath, lineContent, "utf-8");
  } catch (err) {
    console.error(`Failed to append log with rotation to ${filePath}:`, err);
  }
}

/**
 * Scans directory, compresses past days' files (.jsonl/.log -> .gz), and purges files exceeding retention period
 */
export async function runDailyMaintenance(logsDir: string): Promise<{
  compressedFiles: string[];
  purgedFiles: string[];
  totalSavingsBytes: number;
}> {
  const today = getKstDateString();
  const nowMs = Date.now();

  const results = {
    compressedFiles: [] as string[],
    purgedFiles: [] as string[],
    totalSavingsBytes: 0,
  };

  if (!fs.existsSync(logsDir)) return results;

  const entries = fs.readdirSync(logsDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(logsDir, entry.name);

    if (entry.isDirectory()) {
      const subResults = await runDailyMaintenance(fullPath);
      results.compressedFiles.push(...subResults.compressedFiles);
      results.purgedFiles.push(...subResults.purgedFiles);
      results.totalSavingsBytes += subResults.totalSavingsBytes;
      continue;
    }

    const file = entry.name;
    const stats = fs.statSync(fullPath);

    const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
    const fileDateStr = dateMatch ? dateMatch[1] : null;

    // 1. Compress uncompressed past days' files
    const isUncompressedLog = file.endsWith(".jsonl") || file.endsWith(".log");
    if (isUncompressedLog && fileDateStr && fileDateStr < today) {
      try {
        const originalSize = stats.size;
        const gzPath = await gzipCompressFile(fullPath);
        if (gzPath && fs.existsSync(gzPath)) {
          const gzSize = fs.statSync(gzPath).size;
          results.compressedFiles.push(file);
          results.totalSavingsBytes += Math.max(0, originalSize - gzSize);
        }
      } catch (compErr) {
        console.error(`Failed to compress past file ${file}:`, compErr);
      }
      continue;
    }

    // 2. Retention Policy Purge
    const isAuditLog = file.includes("audit") || file.includes("security") || file.includes("dlp");
    const retentionDays = isAuditLog ? LOG_POLICY.auditRetentionDays : LOG_POLICY.generalRetentionDays;
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

    const fileAgeMs = fileDateStr
      ? nowMs - new Date(fileDateStr).getTime()
      : nowMs - stats.mtimeMs;

    if (fileAgeMs > maxAgeMs) {
      try {
        fs.unlinkSync(fullPath);
        results.purgedFiles.push(file);
      } catch (purgeErr) {
        console.error(`Failed to purge expired log ${file}:`, purgeErr);
      }
    }
  }

  return results;
}
