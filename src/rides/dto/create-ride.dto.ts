import { IsLatitude, IsLongitude, IsNotEmpty, IsString } from 'class-validator';

export class CreateRideDto {
  @IsString()
  @IsNotEmpty()
  riderId: string;

  @IsLatitude()
  pickupLat: number;

  @IsLongitude()
  pickupLng: number;
}
