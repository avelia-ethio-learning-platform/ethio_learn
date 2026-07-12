import { IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, registerDecorator, ValidationOptions } from 'class-validator';
import { Role, UserStatus } from '@ethiopialearn/contracts';

/**
 * Strong password: at least 8 characters AND at least 3 of the 4 categories
 * (lowercase, uppercase, number, symbol). Enforced server-side on every place
 * a password is set; the frontend meter mirrors these rules.
 */
export function IsStrongPassword(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || value.length < 8 || value.length > 128) return false;
          const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
          return categories >= 3;
        },
        defaultMessage() {
          return 'Password must be at least 8 characters and include at least 3 of: lowercase, uppercase, number, symbol.';
        },
      },
    });
  };
}

/** Self-signup is limited to the three public-facing roles; QO and platform
 *  admin accounts are provisioned by an existing platform admin / seed. */
export const SELF_SIGNUP_ROLES = [Role.LEARNER, Role.EDUCATOR, Role.INSTITUTION_ADMIN] as const;

export class SignupDto {
  @IsEmail()
  email: string;

  @IsStrongPassword()
  password: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsIn(SELF_SIGNUP_ROLES as unknown as string[])
  role: Role;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordConfirmDto {
  @IsString()
  token: string;

  @IsStrongPassword()
  new_password: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  expertise_area?: string;

  @IsOptional()
  @IsString()
  photo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;
}

export class CreateEducatorProfileDto {
  @IsString()
  @MaxLength(2000)
  bio: string;

  @IsString()
  @MaxLength(200)
  expertise_area: string;

  @IsOptional()
  @IsString()
  photo_url?: string;

  @IsOptional()
  @IsString()
  sample_video_url?: string;
}

export class CreateInstitutionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsString()
  logo_url?: string;
}

export class AddInstructorDto {
  @IsEmail()
  email: string;

  /** Required when inviting a brand-new instructor (an account is created for them). */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  role_in_org?: string;
}

export class ChangePasswordDto {
  @IsStrongPassword()
  new_password: string;
}

export class DeleteAccountDto {
  /** Current password re-entered as confirmation — deleting is irreversible. */
  @IsString()
  password: string;
}

export class CreateStaffDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsIn([Role.QUALITY_OFFICER, Role.PLATFORM_ADMIN] as unknown as string[])
  role: Role;
}

export class AcceptInviteDto {
  @IsString()
  token: string;

  @IsStrongPassword()
  new_password: string;
}

export class UserStatusActionDto {
  @IsIn([UserStatus.ACTIVE, UserStatus.SUSPENDED, UserStatus.BANNED] as unknown as string[])
  status: UserStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UserIdParamDto {
  @IsUUID()
  id: string;
}
