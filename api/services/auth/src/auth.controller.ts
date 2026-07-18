import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { parse, serialize } from 'cookie';
import { AuthService } from './auth.service';
import { AcceptInviteDto, LoginDto, ResetPasswordConfirmDto, ResetPasswordDto, SignupDto } from './dto';

const REFRESH_COOKIE = 'el_refresh';

/** All endpoints here are [PUBLIC] — the gateway allowlists them. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { refresh_token, ...body } = await this.auth.login(dto);
    this.setRefreshCookie(res, refresh_token);
    return body;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parse(req.headers.cookie ?? '');
    const { refresh_token, ...body } = await this.auth.refresh(cookies[REFRESH_COOKIE]);
    this.setRefreshCookie(res, refresh_token);
    return body;
  }

  /** Invitee opens their link → we show whom it belongs to. */
  @Get('invite/:token')
  inviteInfo(@Param('token') token: string) {
    return this.auth.inviteInfo(token);
  }

  /** Invitee sets their own password and is logged straight in. */
  @Post('accept-invite')
  @HttpCode(200)
  async acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    const { refresh_token, ...body } = await this.auth.acceptInvite(dto.token, dto.new_password);
    this.setRefreshCookie(res, refresh_token);
    return body;
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @Post('reset-password/confirm')
  @HttpCode(200)
  confirmReset(@Body() dto: ResetPasswordConfirmDto) {
    return this.auth.confirmPasswordReset(dto.token, dto.new_password);
  }

  private setRefreshCookie(res: Response, token: string) {
    res.setHeader(
      'Set-Cookie',
      serialize(REFRESH_COOKIE, token, {
        httpOnly: true, // spec §0.3: refresh token lives in an httpOnly cookie
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/api/v1/auth',
        maxAge: this.auth.refreshCookieMaxAge(),
      }),
    );
  }
}
