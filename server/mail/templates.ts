export interface MailMessage { to: string; subject: string; text: string; html: string }

export function validateMessage(value: unknown): asserts value is MailMessage {
  if (!value || typeof value !== 'object') throw new Error('MAIL_MESSAGE_INVALID');
  const message = value as Record<string, unknown>;
  if (['to', 'subject', 'text', 'html'].some(key => typeof message[key] !== 'string')) throw new Error('MAIL_MESSAGE_INVALID');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(message['to'] as string) || /[\r\n]/.test(message['subject'] as string)) throw new Error('MAIL_MESSAGE_INVALID');
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function actionMail(input: { name: string; email: string; token: string; purpose: 'activation' | 'reset'; appUrl: string }): MailMessage {
  const activation = input.purpose === 'activation';
  const action = activation ? 'Aktifkan akun' : 'Atur ulang password';
  const intro = activation ? 'Akun Foundation Anda siap diaktifkan. Buat password untuk mulai menggunakan aplikasi.' : 'Kami menerima permintaan untuk mengatur ulang password akun Foundation Anda.';
  const link = new URL(activation ? '/activate' : '/reset-password', input.appUrl);
  link.hash = `token=${encodeURIComponent(input.token)}`;
  const url = link.toString();
  const footer = activation ? 'Jika Anda tidak mengenal permintaan ini, abaikan email ini dan hubungi administrator.' : 'Jika Anda tidak meminta perubahan password, abaikan email ini. Password Anda tidak akan berubah.';
  return {
    to: input.email,
    subject: activation ? 'Aktivasi akun Foundation' : 'Atur ulang password Foundation',
    text: `Halo ${input.name},\n\n${intro}\n\n${action}:\n${url}\n\nTautan hanya dapat digunakan sekali dan memiliki batas waktu.\n\n${footer}\n\nFoundation`,
    html: `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f6f7f9;color:#17212b;font-family:Arial,sans-serif"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td style="padding:32px 16px"><table role="presentation" style="width:100%;max-width:520px;margin:0 auto;background:#fff;border-radius:12px"><tr><td style="padding:32px"><p style="color:#52616b;font-size:14px">FOUNDATION</p><h1 style="font-size:24px">${action}</h1><p>Halo ${escapeHtml(input.name)},</p><p style="line-height:1.6">${intro}</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="background:#155e75;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;display:inline-block">${action}</a></p><p style="font-size:14px;line-height:1.6">Tautan hanya dapat digunakan sekali dan memiliki batas waktu.</p><p style="font-size:14px;line-height:1.6">${footer}</p><p style="font-size:12px;color:#52616b;overflow-wrap:anywhere">Jika tombol tidak berfungsi, buka tautan berikut:<br><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p></td></tr></table></td></tr></table></body></html>`,
  };
}
