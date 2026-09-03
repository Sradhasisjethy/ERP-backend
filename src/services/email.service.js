const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

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

  getLogoAttachment() {
    const logoPath = path.join(__dirname, '../../uploads/assets/infideep-wordmark.png');
    if (fs.existsSync(logoPath)) {
      return [
        {
          filename: 'infideep-logo.png',
          path: logoPath,
          cid: 'infideeplogo',
        },
      ];
    }
    return [];
  }

  async sendPasswordResetEmail({ email, name, resetUrl }) {
    const fromEmail = process.env.FROM_EMAIL || 'noreply@infideep.com';
    const companyName = process.env.COMPANY_NAME || 'INFIDEEP ERP';

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset Your Password - ${companyName}</title>
    </head>
    <body style="margin: 0; padding: 40px 16px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="max-width: 600px; margin: 0 auto;">
        <tr>
          <td>
            <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 40px 36px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
              <tr>
                <td>
                  <!-- Brand Header with Logo -->
                  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom: 28px;">
                    <tr>
                      <td valign="middle" style="padding-right: 10px;">
                        <img src="cid:infideeplogo" alt="INFIDEEP" height="24" style="height: 24px; width: auto; max-width: 170px; display: block; border: 0;" />
                      </td>
                      <td valign="middle">
                        <span style="display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 800; color: #ff0055; letter-spacing: 1px; padding: 3px 8px; background-color: #fff1f2; border: 1px solid #ffe4e6; border-radius: 6px;">ERP</span>
                      </td>
                    </tr>
                  </table>

                  <h1 style="margin: 0 0 16px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
                    Password Reset Request 🔑
                  </h1>

                  <p style="margin: 0 0 16px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #334155;">
                    Hello <strong>${name || 'User'}</strong>,
                  </p>
                  <p style="margin: 0 0 24px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #334155;">
                    We received a request to reset the password for your account associated with <strong>${email}</strong> on <strong>${companyName}</strong>. Please click the button below to choose a new password.
                  </p>

                  <!-- Bulletproof Reset Password Button -->
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${resetUrl}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="18%" strokecolor="#ff0055" fillcolor="#ff0055">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">Reset Password &rarr;</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 32px auto; text-align: center;">
                    <tr>
                      <td align="center" bgcolor="#ff0055" style="border-radius: 10px; background-color: #ff0055;">
                        <a href="${resetUrl}" target="_blank" style="display: inline-block; padding: 16px 38px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 700; color: #ffffff !important; text-decoration: none; border-radius: 10px; background-color: #ff0055; background-image: linear-gradient(135deg, #ff0055 0%, #ff8a00 100%); border: 1px solid #ff0055; letter-spacing: 0.4px; text-align: center; box-shadow: 0 4px 12px rgba(255, 0, 85, 0.3);">
                          Reset Password &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>
                  <!--<![endif]-->

                  <!-- Security Expiry Box -->
                  <div style="background-color: #f8fafc; border-left: 4px solid #ff0055; border-radius: 6px; padding: 14px 18px; margin: 28px 0;">
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #475569; line-height: 1.5;">
                      ⏱️ <strong>Security Notice:</strong> This password reset link is valid for <strong>15 minutes</strong>. If you did not request this, you can safely ignore this email.
                    </p>
                  </div>

                  <!-- Fallback Link -->
                  <p style="margin: 24px 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #64748b; line-height: 1.5;">
                    Or copy and paste this link into your browser:
                  </p>
                  <div style="background-color: #f1f5f9; border: 1px solid #e2e8f0; padding: 12px 14px; border-radius: 6px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 12px; color: #0284c7; word-break: break-all; line-height: 1.5;">
                    <a href="${resetUrl}" style="color: #0284c7; text-decoration: none;">${resetUrl}</a>
                  </div>

                  <!-- Footer -->
                  <div style="margin-top: 36px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; color: #94a3b8; line-height: 1.6;">
                    &copy; ${new Date().getFullYear()} <strong>${companyName}</strong>. All rights reserved.<br/>
                    Enterprise Resource Planning &amp; Operations Management
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
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
          attachments: this.getLogoAttachment(),
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
    const fromEmail = process.env.FROM_EMAIL || 'noreply@infideep.com';
    const companyName = process.env.COMPANY_NAME || 'INFIDEEP ERP';

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to ${companyName} - Set Up Your Account Password</title>
    </head>
    <body style="margin: 0; padding: 40px 16px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="max-width: 600px; margin: 0 auto;">
        <tr>
          <td>
            <!-- Card Container -->
            <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 40px 36px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
              <tr>
                <td>
                  <!-- Brand Header with Logo -->
                  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom: 28px;">
                    <tr>
                      <td valign="middle" style="padding-right: 10px;">
                        <img src="cid:infideeplogo" alt="INFIDEEP" height="24" style="height: 24px; width: auto; max-width: 170px; display: block; border: 0;" />
                      </td>
                      <td valign="middle">
                        <span style="display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 800; color: #ff0055; letter-spacing: 1px; padding: 3px 8px; background-color: #fff1f2; border: 1px solid #ffe4e6; border-radius: 6px;">ERP</span>
                      </td>
                    </tr>
                  </table>

                  <!-- Greeting Heading -->
                  <h1 style="margin: 0 0 16px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 800; color: #0f172a; line-height: 1.3;">
                    Welcome aboard, ${name || 'Team Member'}! 👋
                  </h1>

                  <!-- Message Paragraph -->
                  <p style="margin: 0 0 24px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #334155;">
                    Your account on <strong>${companyName}</strong> has been created. Please click the button below to set your account password and complete your onboarding setup.
                  </p>

                  <!-- Bulletproof "Set Password" Button -->
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${setupUrl}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="18%" strokecolor="#ff0055" fillcolor="#ff0055">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">Set Your Password &rarr;</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-->
                  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 32px auto; text-align: center;">
                    <tr>
                      <td align="center" bgcolor="#ff0055" style="border-radius: 10px; background-color: #ff0055;">
                        <a href="${setupUrl}" target="_blank" style="display: inline-block; padding: 16px 38px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 700; color: #ffffff !important; text-decoration: none; border-radius: 10px; background-color: #ff0055; background-image: linear-gradient(135deg, #ff0055 0%, #ff8a00 100%); border: 1px solid #ff0055; letter-spacing: 0.4px; text-align: center; box-shadow: 0 4px 12px rgba(255, 0, 85, 0.3);">
                          Set Your Password &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>
                  <!--<![endif]-->

                  <!-- Expiry Box -->
                  <div style="background-color: #f8fafc; border-left: 4px solid #ff0055; border-radius: 6px; padding: 14px 18px; margin: 28px 0;">
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #475569; line-height: 1.5;">
                      ⏱️ <strong>Security Notice:</strong> This invitation link is valid for <strong>48 hours</strong>.
                    </p>
                  </div>

                  <!-- Fallback Link -->
                  <p style="margin: 24px 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #64748b; line-height: 1.5;">
                    Or copy and paste this URL into your browser:
                  </p>
                  <div style="background-color: #f1f5f9; border: 1px solid #e2e8f0; padding: 12px 14px; border-radius: 6px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 12px; color: #0284c7; word-break: break-all; line-height: 1.5;">
                    <a href="${setupUrl}" style="color: #0284c7; text-decoration: none;">${setupUrl}</a>
                  </div>

                  <!-- Footer -->
                  <div style="margin-top: 36px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; color: #94a3b8; line-height: 1.6;">
                    &copy; ${new Date().getFullYear()} <strong>${companyName}</strong>. All rights reserved.<br/>
                    Enterprise Resource Planning &amp; Operations Management
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
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
          attachments: this.getLogoAttachment(),
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
