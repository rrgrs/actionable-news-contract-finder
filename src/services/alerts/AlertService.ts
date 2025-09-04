import { AlertConfig } from '../../config/types';
import * as nodemailer from 'nodemailer';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface AlertPayload {
  newsTitle: string;
  newsUrl: string;
  marketTitle: string;
  marketUrl: string;
  contractTitle: string;
  suggestedPosition: 'buy' | 'sell';
  confidence: number;
  currentPrice: number;
  reasoning: string;
  timestamp: Date;
}

export class AlertService {
  private config: AlertConfig;
  private emailTransporter?: nodemailer.Transporter;
  private alertHistory: Map<string, Date> = new Map(); // Track when we last alerted for a market

  constructor(config: AlertConfig) {
    this.config = config;
    this.initializeEmailTransporter();
  }

  private initializeEmailTransporter(): void {
    if (this.config.type === 'email' || this.config.type === 'both') {
      if (!this.config.emailConfig) {
        console.warn('Email alerts configured but email settings not provided');
        return;
      }

      const { smtpHost, smtpPort, smtpUser, smtpPass } = this.config.emailConfig;

      if (!smtpHost) {
        console.warn('Email alerts configured but SMTP host not provided');
        return;
      }

      this.emailTransporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort || 587,
        secure: smtpPort === 465,
        auth:
          smtpUser && smtpPass
            ? {
                user: smtpUser,
                pass: smtpPass,
              }
            : undefined,
      });
    }
  }

  async sendAlert(payload: AlertPayload): Promise<void> {
    // Check confidence threshold
    if (
      this.config.minConfidenceThreshold &&
      payload.confidence < this.config.minConfidenceThreshold
    ) {
      console.log(
        `Skipping alert for ${payload.marketTitle} - confidence ${payload.confidence} below threshold ${this.config.minConfidenceThreshold}`,
      );
      return;
    }

    // Check cooldown
    if (this.shouldSkipDueToCooldown(payload.marketUrl)) {
      console.log(`Skipping alert for ${payload.marketTitle} - still in cooldown period`);
      return;
    }

    // Send alerts based on configuration
    const promises: Promise<void>[] = [];

    if (this.config.type === 'email' || this.config.type === 'both') {
      promises.push(this.sendEmailAlert(payload));
    }

    if (this.config.type === 'system' || this.config.type === 'both') {
      promises.push(this.sendSystemAlert(payload));
    }

    await Promise.all(promises);

    // Update alert history
    this.alertHistory.set(payload.marketUrl, new Date());
  }

  private shouldSkipDueToCooldown(marketUrl: string): boolean {
    if (!this.config.cooldownMinutes) {
      return false;
    }

    const lastAlert = this.alertHistory.get(marketUrl);
    if (!lastAlert) {
      return false;
    }

    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    const timeSinceLastAlert = Date.now() - lastAlert.getTime();

    return timeSinceLastAlert < cooldownMs;
  }

  private async sendEmailAlert(payload: AlertPayload): Promise<void> {
    if (!this.emailTransporter || !this.config.emailConfig) {
      console.warn('Email transporter not initialized, skipping email alert');
      return;
    }

    const { to, from } = this.config.emailConfig;

    if (!to || to.length === 0) {
      console.warn('No email recipients configured, skipping email alert');
      return;
    }

    const subject = `🎯 Trading Opportunity: ${payload.marketTitle} (${Math.round(payload.confidence * 100)}% confidence)`;

    const html = `
      <h2>Trading Opportunity Found</h2>
      
      <h3>📰 News Event</h3>
      <p><strong>${payload.newsTitle}</strong></p>
      <p><a href="${payload.newsUrl}">View News Article</a></p>
      
      <h3>📊 Market Opportunity</h3>
      <p><strong>Market:</strong> ${payload.marketTitle}</p>
      <p><strong>Contract:</strong> ${payload.contractTitle}</p>
      <p><strong>Current Price:</strong> $${payload.currentPrice.toFixed(2)}</p>
      <p><strong>Suggested Position:</strong> <span style="color: ${payload.suggestedPosition === 'buy' ? 'green' : 'red'}; font-weight: bold;">${payload.suggestedPosition.toUpperCase()}</span></p>
      <p><strong>Confidence:</strong> ${Math.round(payload.confidence * 100)}%</p>
      <p><a href="${payload.marketUrl}">View Market</a></p>
      
      <h3>💡 Analysis</h3>
      <p>${payload.reasoning}</p>
      
      <hr>
      <p style="color: #666; font-size: 12px;">
        Alert generated at ${payload.timestamp.toLocaleString()}<br>
        Automated trading alert from Actionable News Contract Finder
      </p>
    `;

    const text = `
Trading Opportunity Found

NEWS EVENT
${payload.newsTitle}
${payload.newsUrl}

MARKET OPPORTUNITY
Market: ${payload.marketTitle}
Contract: ${payload.contractTitle}
Current Price: $${payload.currentPrice.toFixed(2)}
Suggested Position: ${payload.suggestedPosition.toUpperCase()}
Confidence: ${Math.round(payload.confidence * 100)}%
Market URL: ${payload.marketUrl}

ANALYSIS
${payload.reasoning}

Alert generated at ${payload.timestamp.toLocaleString()}
    `.trim();

    try {
      await this.emailTransporter.sendMail({
        from: from,
        to: to.join(', '),
        subject,
        text,
        html,
      });
      console.log(`✉️  Email alert sent to ${to.join(', ')}`);
    } catch (error) {
      console.error('Failed to send email alert:', error);
    }
  }

  private async sendSystemAlert(payload: AlertPayload): Promise<void> {
    const platform = process.platform;
    const title = `Trading Opportunity: ${payload.marketTitle}`;
    const message = `${payload.suggestedPosition.toUpperCase()} - ${Math.round(payload.confidence * 100)}% confidence at $${payload.currentPrice.toFixed(2)}`;

    try {
      if (platform === 'darwin') {
        // macOS
        const script = `display notification "${message}" with title "${title}" sound name "default"`;
        await execAsync(`osascript -e '${script}'`);
      } else if (platform === 'linux') {
        // Linux (requires notify-send)
        await execAsync(`notify-send "${title}" "${message}" -u critical`);
      } else if (platform === 'win32') {
        // Windows (using PowerShell)
        const psCommand = `
          Add-Type -AssemblyName System.Windows.Forms
          $notification = New-Object System.Windows.Forms.NotifyIcon
          $notification.Icon = [System.Drawing.SystemIcons]::Information
          $notification.BalloonTipTitle = "${title}"
          $notification.BalloonTipText = "${message}"
          $notification.Visible = $true
          $notification.ShowBalloonTip(10000)
        `.replace(/\n/g, '; ');
        await execAsync(`powershell -Command "${psCommand}"`);
      }
      console.log(`🔔 System alert sent: ${title}`);
    } catch (error) {
      console.error('Failed to send system alert:', error);
      // Fallback to console notification
      console.log(`\n🔔 ALERT: ${title}\n   ${message}\n`);
    }
  }

  async testConnection(): Promise<boolean> {
    if (this.config.type === 'none') {
      console.log('Alerts disabled');
      return true;
    }

    if (this.config.type === 'email' || this.config.type === 'both') {
      if (this.emailTransporter) {
        try {
          await this.emailTransporter.verify();
          console.log('✅ Email connection verified');
        } catch (error) {
          console.error('❌ Email connection failed:', error);
          return false;
        }
      }
    }

    if (this.config.type === 'system' || this.config.type === 'both') {
      // Test system notification
      try {
        await this.sendSystemAlert({
          newsTitle: 'Test News',
          newsUrl: 'https://test.com',
          marketTitle: 'Test Alert',
          marketUrl: 'https://market.test.com',
          contractTitle: 'TEST',
          suggestedPosition: 'buy',
          confidence: 0.95,
          currentPrice: 0.5,
          reasoning: 'This is a test alert to verify system notifications are working',
          timestamp: new Date(),
        });
      } catch (error) {
        console.error('❌ System alert test failed:', error);
        return false;
      }
    }

    return true;
  }
}
