/** Resend "from" / reply-to defaults for transactional mail. */
export const RESEND_FROM_DEFAULT = "bloot <noreply@bloot.app>";
export const RESEND_REPLY_TO_DEFAULT = "support@bloot.app";

export function getResendFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || RESEND_FROM_DEFAULT;
}

export function getResendReplyTo(): string {
  return process.env.RESEND_REPLY_TO?.trim() || RESEND_REPLY_TO_DEFAULT;
}
