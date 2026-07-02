import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { RidesService } from './rides.service';
import { CreateRideDto } from './dto/create-ride.dto';
import { AcceptRideDto } from './dto/accept-ride.dto';

@Controller('rides')
export class RidesController {
  constructor(private readonly ridesService: RidesService) {}

  @Post()
  create(@Body() dto: CreateRideDto) {
    return this.ridesService.createRide(dto);
  }

  @Get()
  findAll() {
    return this.ridesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ridesService.findOne(id);
  }

  @Get(':id/notifications')
  getNotifications(@Param('id') id: string) {
    return this.ridesService.getNotifications(id);
  }

  @Get(':id/history')
  getHistory(@Param('id') id: string) {
    return this.ridesService.getStateHistory(id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@Param('id') id: string, @Body() dto: AcceptRideDto) {
    return this.ridesService.acceptRide(id, dto.driverId);
  }
}
