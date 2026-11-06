export interface R2Settings {
  endpoint: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

export function r2Settings(config: { r2Endpoint?: unknown; r2Bucket?: unknown }, env: Record<string, string | undefined>): R2Settings {
  if (typeof config.r2Endpoint !== 'string' || typeof config.r2Bucket !== 'string'
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(config.r2Bucket)) {
    throw new Error('请配置合法的 r2Endpoint 和 r2Bucket');
  }
  let endpoint: URL;
  try { endpoint = new URL(config.r2Endpoint); } catch { throw new Error('r2Endpoint 格式无效'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || !/^[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/u.test(endpoint.hostname)) {
    throw new Error('r2Endpoint 必须为账号级 HTTPS R2 S3 地址，不包含桶名或查询参数');
  }
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new Error('请在本机 .env.local 中设置 R2_ACCESS_KEY_ID 和 R2_SECRET_ACCESS_KEY');
  return { endpoint: endpoint.origin, bucket: config.r2Bucket, credentials: { accessKeyId, secretAccessKey } };
}
