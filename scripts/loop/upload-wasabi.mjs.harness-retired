// upload-wasabi.mjs — push a file to a Wasabi bucket and return its public URL.
//
// Wasabi is S3-API-compatible, so we drive it with the AWS SDK v3 S3 client
// pointed at a Wasabi endpoint. The autonomous loop uploads the review
// screenshot here and hands the returned URL to Telegram so the human can open
// it from their phone without VPN or local access.
//
// The AWS SDK is an OPTIONAL dependency: it is imported dynamically so this file
// passes `node --check` even when @aws-sdk/client-s3 is not installed.
//
// Required env (validated at runtime; missing ones are listed before we exit):
//   WASABI_ACCESS_KEY_ID      access key
//   WASABI_SECRET_ACCESS_KEY  secret key
//   WASABI_BUCKET             target bucket (assumed public per bucket policy)
//   WASABI_REGION             region                 (default us-east-1)
//   WASABI_ENDPOINT           S3 endpoint            (default https://s3.<region>.wasabisys.com)

import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import { log } from "./telemetry.mjs";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function contentTypeFor(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] || "application/octet-stream";
}

function requireEnv() {
  const region = process.env.WASABI_REGION || "us-east-1";
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  const cfg = {
    accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
    secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
    bucket: process.env.WASABI_BUCKET,
    region,
    endpoint,
  };
  const missing = [];
  if (!cfg.accessKeyId) missing.push("WASABI_ACCESS_KEY_ID");
  if (!cfg.secretAccessKey) missing.push("WASABI_SECRET_ACCESS_KEY");
  if (!cfg.bucket) missing.push("WASABI_BUCKET");
  if (missing.length) {
    console.error(`missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }
  return cfg;
}

/**
 * Upload a local file to Wasabi and return its static public URL.
 * @param {string} localPath  path to the file to upload
 * @param {{key?:string}} [opts]  object key (default prod-preview/<basename>)
 * @returns {Promise<string>} public URL
 */
export async function upload(localPath, { key } = {}) {
  if (!localPath) {
    console.error("usage: upload(localPath, { key })");
    process.exit(2);
  }
  const cfg = requireEnv();
  const objectKey = key || `prod-preview/${basename(localPath)}`;

  let s3sdk;
  try {
    s3sdk = await import("@aws-sdk/client-s3");
  } catch {
    console.error("install: npm i @aws-sdk/client-s3");
    process.exit(127);
  }

  const { S3Client, PutObjectCommand } = s3sdk;
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: objectKey,
      Body: readFileSync(localPath),
      ContentType: contentTypeFor(localPath),
    }),
  );

  // Static public URL — assumes the bucket policy makes objects publicly readable.
  const url = `${cfg.endpoint}/${cfg.bucket}/${objectKey}`;

  try {
    await log("iterate", { actor: "wasabi", detail: { key: objectKey, url } });
  } catch { /* telemetry must never break the upload */ }

  return url;
}

// CLI: `node scripts/loop/upload-wasabi.mjs <localPath> [key]`
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [localPath, key] = process.argv.slice(2);
  if (!localPath) {
    console.error("usage: upload-wasabi.mjs <localPath> [key]");
    process.exit(2);
  }
  upload(localPath, { key })
    .then((url) => console.log(url))
    .catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
