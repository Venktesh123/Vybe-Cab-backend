import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Driver, DriverStatus } from './entities/driver.entity';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(Driver)
    private readonly driverRepo: Repository<Driver>,
    private readonly redis: RedisService,
  ) {}

  async create(dto: CreateDriverDto): Promise<Driver> {
    const driver = this.driverRepo.create({
      name: dto.name,
      lat: dto.lat,
      lng: dto.lng,
      status: DriverStatus.AVAILABLE,
    });
    const saved = await this.driverRepo.save(driver);
    await this.redis.upsertDriverLocation(saved.id, saved.lng, saved.lat);
    return saved;
  }

  async findAll(): Promise<Driver[]> {
    return this.driverRepo.find();
  }

  async findOne(id: string): Promise<Driver> {
    const driver = await this.driverRepo.findOne({ where: { id } });
    if (!driver) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
    return driver;
  }

  /**
   * A driver's position can change between searches -- this is the single
   * write path for location updates, and it keeps Postgres (source of
   * truth for driver profile/status) and the Redis GEO index (used for
   * fast proximity search) consistent with each other.
   */
  async updateLocation(id: string, dto: UpdateLocationDto): Promise<Driver> {
    const driver = await this.findOne(id);
    driver.lat = dto.lat;
    driver.lng = dto.lng;
    const saved = await this.driverRepo.save(driver);

    if (driver.status === DriverStatus.AVAILABLE) {
      await this.redis.upsertDriverLocation(saved.id, saved.lng, saved.lat);
    }
    return saved;
  }

  async setStatus(id: string, status: DriverStatus): Promise<Driver> {
    const driver = await this.findOne(id);
    driver.status = status;
    const saved = await this.driverRepo.save(driver);

    if (status === DriverStatus.AVAILABLE) {
      await this.redis.upsertDriverLocation(saved.id, saved.lng, saved.lat);
    } else {
      // Busy/offline drivers should not surface in new proximity searches.
      await this.redis.removeDriverFromGeo(saved.id);
    }
    return saved;
  }
}
