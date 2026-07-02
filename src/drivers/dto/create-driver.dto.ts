import { IsLatitude, IsLongitude, IsNotEmpty, IsString } from 'class-validator';

export class CreateDriverDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}
