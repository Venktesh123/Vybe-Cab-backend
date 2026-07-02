import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

/**
 * Builds ioredis connection options from environment variables.
 *
 * Supports two styles, same pattern as the Postgres config:
 *   - REDIS_URL: a single connection string, e.g.
 *       redis://default:password@host:port
 *       rediss://default:password@host:port   (rediss:// = TLS)
 *     This is what most managed Redis providers (Render, Upstash, Redis
 *     Cloud, etc.) give you.
 *   - Discrete REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_TLS vars,
 *     used by default for local/docker-compose Redis (no password, no TLS).
 *
 * REDIS_TLS=true forces TLS on even when using discrete vars; with
 * REDIS_URL, TLS is inferred automatically from the `rediss://` scheme
 * unless REDIS_TLS explicitly overrides it.
 */
export function buildRedisConnectionOptions(
  config: ConfigService,
): RedisOptions {
  const redisUrl = config.get<string>('REDIS_URL');
  const tlsOverride = config.get<string>('REDIS_TLS');

  if (redisUrl) {
    const url = new URL(redisUrl);
    const tls =
      tlsOverride !== undefined
        ? tlsOverride === 'true'
        : url.protocol === 'rediss:';

    return {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      username: url.username || undefined,
      password: url.password || undefined,
      tls: tls ? {} : undefined,
      maxRetriesPerRequest: 3,
    };
  }

  const tls = tlsOverride === 'true';

  return {
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: parseInt(config.get<string>('REDIS_PORT', '6379'), 10),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    tls: tls ? {} : undefined,
    maxRetriesPerRequest: 3,
  };
}
