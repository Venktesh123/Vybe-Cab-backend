import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';


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
