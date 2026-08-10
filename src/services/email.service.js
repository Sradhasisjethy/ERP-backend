const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initTransporter();
  }

  initTransporter() {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: Number(port) === 465, // true for 465, false for other ports
        auth: { user, pass },
      });
      console.log(`[EmailService] SMTP Transporter configured for host: ${host}`);
    } else {
      console.log('[EmailService] SMTP credentials not fully configured in .env yet. Emails will be logged to console in Dev Mode.');
    }
  }

  async sendPasswordResetEmail({ email, name, resetUrl }) {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@erppro.com';
    const companyName = process.env.COMPANY_NAME || 'ERP Pro';

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reset Your Password</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; }
        .container { max-width: 560px; margin: 0 auto; background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(16px); border-radius: 16px; padding: 40px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
        .logo { font-size: 24px; font-weight: 800; color: #3b82f6; margin-bottom: 24px; letter-spacing: -0.5px; }
        h1 { font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 12px; }
        p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 24px; }
        .btn-container { text-align: center; margin: 32px 0; }
        .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 32px; border-radius: 10px; box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.4); transition: all 0.2s ease; }
        .footer { font-size: 12px; color: #64748b; margin-top: 32px; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 20px; text-align: center; }
        .url-box { background: rgba(15, 23, 42, 0.6); padding: 12px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #60a5fa; word-break: break-all; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">✨ ${companyName}</div>
        <h1>Password Reset Request</h1>
        <p>Hello ${name || 'User'},</p>
        <p>We received a request to reset the password for your account associated with <strong>${email}</strong>. Click the button below to reset your password. This link is valid for <strong>15 minutes</strong>.</p>
        
        <div class="btn-container">
          <a href="${resetUrl}" target="_blank" class="btn">Reset Password</a>
        </div>

        <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
        
        <p>Or copy and paste this URL into your browser:</p>
        <div class="url-box">${resetUrl}</div>

        <div class="footer">
          &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.
        </div>
      </div>
    </body>
    </html>
    `;

    // Re-check transporter if env updated dynamically
    if (!this.transporter && process.env.SMTP_HOST) {
      this.initTransporter();
    }

    if (this.transporter) {
      try {
        const info = await this.transporter.sendMail({
          from: `"${companyName}" <${fromEmail}>`,
          to: email,
          subject: `🔑 Reset Your Password - ${companyName}`,
          html: htmlContent,
        });
        console.log(`[EmailService] Password reset email sent to ${email}. MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
      } catch (err) {
        console.error(`[EmailService] Failed to send email via SMTP:`, err.message);
        console.log(`[EmailService DEV FALLBACK] Reset Link for ${email}: ${resetUrl}`);
        return { success: false, fallbackUrl: resetUrl, error: err.message };
      }
    } else {
      console.log(`\n======================================================`);
      console.log(`[EmailService DEV MODE - NO SMTP ENV DEFINED YET]`);
      console.log(`To: ${email}`);
      console.log(`Reset Password Link: ${resetUrl}`);
      console.log(`======================================================\n`);
      return { success: true, isDevFallback: true, resetUrl };
    }
  }

  async sendWelcomeInviteEmail({ email, name, setupUrl }) {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@erppro.com';
    const companyName = process.env.COMPANY_NAME || 'ERP Pro';

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Welcome to ${companyName} - Activate Your Account</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; }
        .container { max-width: 560px; margin: 0 auto; background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(16px); border-radius: 16px; padding: 40px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
        .logo { font-size: 24px; font-weight: 800; color: #3b82f6; margin-bottom: 24px; letter-spacing: -0.5px; }
        h1 { font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 12px; }
        p { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 24px; }
        .btn-container { text-align: center; margin: 32px 0; }
        .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 32px; border-radius: 10px; box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.4); transition: all 0.2s ease; }
        .footer { font-size: 12px; color: #64748b; margin-top: 32px; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 20px; text-align: center; }
        .url-box { background: rgba(15, 23, 42, 0.6); padding: 12px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #60a5fa; word-break: break-all; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">✨ ${companyName}</div>
        <h1>Welcome aboard, ${name || 'Team Member'}!</h1>
        <p>Your account on <strong>${companyName}</strong> has been created. Please click the button below to set your account password and complete your onboarding setup.</p>
        
        <div class="btn-container">
          <a href="${setupUrl}" target="_blank" class="btn">Set Your Password</a>
        </div>

        <p>This invitation link is valid for <strong>48 hours</strong>.</p>
        
        <p>Or copy and paste this URL into your browser:</p>
        <div class="url-box">${setupUrl}</div>

        <div class="footer">
          &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.
        </div>
      </div>
    </body>
    </html>
    `;

    if (!this.transporter && process.env.SMTP_HOST) {
      this.initTransporter();
    }

    if (this.transporter) {
      try {
        const info = await this.transporter.sendMail({
          from: `"${companyName}" <${fromEmail}>`,
          to: email,
          subject: `🎉 Welcome to ${companyName} - Set Up Your Account Password`,
          html: htmlContent,
        });
        console.log(`[EmailService] Welcome invite email sent to ${email}. MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
      } catch (err) {
        console.error(`[EmailService] Failed to send welcome invite email via SMTP:`, err.message);
        console.log(`[EmailService DEV FALLBACK] Account Setup Link for ${email}: ${setupUrl}`);
        return { success: false, fallbackUrl: setupUrl, error: err.message };
      }
    } else {
      console.log(`\n======================================================`);
      console.log(`[EmailService DEV MODE - NO SMTP ENV DEFINED YET]`);
      console.log(`To: ${email}`);
      console.log(`Welcome Account Setup Link: ${setupUrl}`);
      console.log(`======================================================\n`);
      return { success: true, isDevFallback: true, setupUrl };
    }
  }
}

module.exports = new EmailService();
