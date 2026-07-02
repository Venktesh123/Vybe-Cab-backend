import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { Ride } from '../rides/entities/ride.entity';
import { RideStateTransition } from '../rides/entities/ride-state-transition.entity';
import { Driver } from '../drivers/entities/driver.entity';

dotenv.config();

const entities = [Ride, RideStateTransition, Driver];
const migrations = ['dist/database/migrations/*.js'];

// synchronize is convenient for this take-home so the schema is created
// automatically on first boot without a manual migration step. In a real
// production system this would be false, with migrations run explicitly
// in CI/CD -- see write-up.
const synchronize = true;
const logging = false;

/**
 * Most managed Postgres providers (Render, Heroku, Supabase, etc.) give you
 * a single DATABASE_URL and require SSL over the public internet, but don't
 * present a certificate the default Node TLS trust store recognizes. We
 * honor DATABASE_URL when present -- falling back to the discrete
 * POSTGRES_* vars for local/docker-compose use, which don't need SSL.
 *
 * PGSSL=true|false lets you override the auto-detection either way.
 */
const databaseUrl = process.env.DATABASE_URL;

const sslEnabled =
  process.env.PGSSL !== undefined
    ? process.env.PGSSL === 'true'
    : Boolean(databaseUrl);

export const typeOrmConfig: DataSourceOptions = databaseUrl
  ? {
      type: 'postgres',
      url: databaseUrl,
      entities,
      migrations,
      synchronize,
      logging,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    }
  : {
      type: 'postgres',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'vybe',
      password: process.env.POSTGRES_PASSWORD || 'vybe_password',
      database: process.env.POSTGRES_DB || 'vybe_cabs',
      entities,
      migrations,
      synchronize,
      logging,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    };

export default new DataSource(typeOrmConfig);

