import { IsNotEmpty, IsString } from 'class-validator';

export class AcceptRideDto {
  @IsString()
  @IsNotEmpty()
  driverId: string;
}
