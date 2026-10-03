import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { InviteTokenPipe } from '@ethiopialearn/common';
import { Request, Response } from 'express';
import { parse } from 'cookie';
import { AuthService } from './auth.service';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie';
import { AcceptInviteDto, GoogleSignInDto, LoginDto, ResendVerificationDto, ResetPasswordConfirmDto, ResetPasswordDto, SignupDto } from './dto';

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

  /** A fresh verification link. The same 200 whatever the account's state, so it never reveals one. */
  @Post('resend-verification')
  @HttpCode(200)
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { refresh_token, ...body } = await this.auth.login(dto);
    this.setRefreshCookie(res, refresh_token);
    return body;
  }

  /** Google sign-in: exchange a verified Google ID token for our own session. */
  @Post('google')
  @HttpCode(200)
  async google(@Body() dto: GoogleSignInDto, @Res({ passthrough: true }) res: Response) {
    const { refresh_token, ...body } = await this.auth.googleSignIn(dto.id_token);
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

  /**
   * Log out: revoke the refresh token server-side and clear the cookie. Without
   * this, "log out" only forgot the token client-side while it stayed valid in
   * Redis for up to 7 days — a real session-fixation risk on shared devices.
   */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = parse(req.headers.cookie ?? '');
    await this.auth.logout(cookies[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    return { ok: true };
  }

  /** Invitee opens their link → we show whom it belongs to. */
  @Get('invite/:token')
  inviteInfo(@Param('token', new InviteTokenPipe()) token: string) {
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
    setRefreshCookie(res, token, this.auth.refreshCookieMaxAge());
  }
}
