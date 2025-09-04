import { AlertService, AlertPayload } from '../AlertService';
import { AlertConfig } from '../../../config/types';
import * as nodemailer from 'nodemailer';

// Mock nodemailer
jest.mock('nodemailer');

// Mock child_process for system notifications
jest.mock('child_process', () => ({
  exec: jest.fn((_cmd: string, callback: any) => callback(null, 'success', '')),
}));

describe('AlertService', () => {
  let alertService: AlertService;
  let mockTransporter: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Setup mock transporter
    mockTransporter = {
      sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with none type', () => {
      const config: AlertConfig = { type: 'none' };
      alertService = new AlertService(config);
      expect(alertService).toBeDefined();
    });

    it('should initialize with email type and create transporter', () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpUser: 'user',
          smtpPass: 'pass',
        },
      };

      alertService = new AlertService(config);

      expect(nodemailer.createTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'user',
          pass: 'pass',
        },
      });
    });

    it('should initialize with system type', () => {
      const config: AlertConfig = { type: 'system' };
      alertService = new AlertService(config);
      expect(alertService).toBeDefined();
    });

    it('should initialize with both type', () => {
      const config: AlertConfig = {
        type: 'both',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
      };
      alertService = new AlertService(config);
      expect(alertService).toBeDefined();
    });
  });

  describe('sendAlert', () => {
    const mockPayload: AlertPayload = {
      newsTitle: 'Test News',
      newsUrl: 'https://news.com',
      marketTitle: 'Test Market',
      marketUrl: 'https://market.com',
      contractTitle: 'Test Contract',
      suggestedPosition: 'buy',
      confidence: 0.85,
      currentPrice: 0.65,
      reasoning: 'Test reasoning',
      timestamp: new Date(),
    };

    it('should not send alert when type is none', async () => {
      const config: AlertConfig = { type: 'none' };
      alertService = new AlertService(config);

      await alertService.sendAlert(mockPayload);

      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('should send email alert when type is email', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
      };
      alertService = new AlertService(config);

      await alertService.sendAlert(mockPayload);

      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'sender@example.com',
          to: 'test@example.com',
          subject: expect.stringContaining('Trading Opportunity'),
        })
      );
    });

    it('should send system alert when type is system', async () => {
      const config: AlertConfig = { type: 'system' };
      alertService = new AlertService(config);

      const { exec } = require('child_process');
      await alertService.sendAlert(mockPayload);

      expect(exec).toHaveBeenCalled();
    });

    it('should send both alerts when type is both', async () => {
      const config: AlertConfig = {
        type: 'both',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
      };
      alertService = new AlertService(config);

      const { exec } = require('child_process');
      await alertService.sendAlert(mockPayload);

      expect(mockTransporter.sendMail).toHaveBeenCalled();
      expect(exec).toHaveBeenCalled();
    });

    it('should respect confidence threshold', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
        minConfidenceThreshold: 0.9,
      };
      alertService = new AlertService(config);

      await alertService.sendAlert(mockPayload); // confidence 0.85 < 0.9

      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('should send alert when confidence meets threshold', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
        minConfidenceThreshold: 0.8,
      };
      alertService = new AlertService(config);

      await alertService.sendAlert(mockPayload); // confidence 0.85 > 0.8

      expect(mockTransporter.sendMail).toHaveBeenCalled();
    });

    it('should respect cooldown period', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
        cooldownMinutes: 10,
      };
      alertService = new AlertService(config);

      // First alert should send
      await alertService.sendAlert({
        ...mockPayload,
        marketUrl: 'https://market.com/market-1',
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);

      // Second alert for same market should not send
      await alertService.sendAlert({
        ...mockPayload,
        marketUrl: 'https://market.com/market-1',
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);

      // Alert for different market should send
      await alertService.sendAlert({
        ...mockPayload,
        marketUrl: 'https://market.com/market-2',
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(2);
    });

    it('should send alert after cooldown expires', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
        cooldownMinutes: 10,
      };
      alertService = new AlertService(config);

      // First alert
      await alertService.sendAlert({
        ...mockPayload,
        marketUrl: 'https://market.com/market-1',
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);

      // Advance time past cooldown
      jest.advanceTimersByTime(11 * 60 * 1000);

      // Second alert should now send
      await alertService.sendAlert({
        ...mockPayload,
        marketUrl: 'https://market.com/market-1',
      });
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(2);
    });

    it('should handle email send errors gracefully', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
      };
      alertService = new AlertService(config);

      mockTransporter.sendMail.mockRejectedValueOnce(new Error('SMTP error'));

      await expect(alertService.sendAlert(mockPayload)).resolves.not.toThrow();
    });

    it('should handle system notification errors gracefully', async () => {
      const config: AlertConfig = { type: 'system' };
      alertService = new AlertService(config);

      const { exec } = require('child_process');
      exec.mockImplementationOnce((_cmd: string, callback: any) =>
        callback(new Error('Notification error'), '', 'error')
      );

      await expect(alertService.sendAlert(mockPayload)).resolves.not.toThrow();
    });
  });

  describe('formatters', () => {
    it('should format email properly', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
      };
      alertService = new AlertService(config);

      const payload: AlertPayload = {
        newsTitle: 'Error News',
        newsUrl: 'https://news.com',
        marketTitle: 'Error Market',
        marketUrl: 'https://market.com',
        contractTitle: 'Error Contract',
        suggestedPosition: 'buy',
        confidence: 0.5,
        currentPrice: 0.5,
        reasoning: 'Error occurred',
        timestamp: new Date(),
      };

      await alertService.sendAlert(payload);

      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('Trading Opportunity'),
          html: expect.stringContaining('Error'),
        })
      );
    });

    it('should include confidence in opportunity alerts', async () => {
      const config: AlertConfig = {
        type: 'email',
        emailConfig: {
          to: ['test@example.com'],
          from: 'sender@example.com',
          smtpHost: 'smtp.test.com',
        },
      };
      alertService = new AlertService(config);

      const payload: AlertPayload = {
        newsTitle: 'Opportunity News',
        newsUrl: 'https://news.com',
        marketTitle: 'Opportunity Market',
        marketUrl: 'https://market.com',
        contractTitle: 'Opportunity Contract',
        suggestedPosition: 'buy',
        confidence: 0.95,
        currentPrice: 0.5,
        reasoning: 'High confidence',
        timestamp: new Date(),
      };

      await alertService.sendAlert(payload);

      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('95%'),
        })
      );
    });
  });

  describe('platform-specific notifications', () => {
    it('should use correct command for macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const config: AlertConfig = { type: 'system' };
      alertService = new AlertService(config);

      const { exec } = require('child_process');
      await alertService.sendAlert({
        newsTitle: 'Test',
        newsUrl: 'https://news.com',
        marketTitle: 'Test',
        marketUrl: 'https://market.com',
        contractTitle: 'Test',
        suggestedPosition: 'buy',
        confidence: 0.5,
        currentPrice: 0.5,
        reasoning: 'Test message',
        timestamp: new Date(),
      });

      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('osascript'),
        expect.any(Function)
      );
    });

    it('should use correct command for Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const config: AlertConfig = { type: 'system' };
      alertService = new AlertService(config);

      const { exec } = require('child_process');
      await alertService.sendAlert({
        newsTitle: 'Test',
        newsUrl: 'https://news.com',
        marketTitle: 'Test',
        marketUrl: 'https://market.com',
        contractTitle: 'Test',
        suggestedPosition: 'buy',
        confidence: 0.5,
        currentPrice: 0.5,
        reasoning: 'Test message',
        timestamp: new Date(),
      });

      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('powershell'),
        expect.any(Function)
      );
    });

    it('should use correct command for Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const config: AlertConfig = { type: 'system' };
      alertService = new AlertService(config);

      const { exec } = require('child_process');
      await alertService.sendAlert({
        newsTitle: 'Test',
        newsUrl: 'https://news.com',
        marketTitle: 'Test',
        marketUrl: 'https://market.com',
        contractTitle: 'Test',
        suggestedPosition: 'buy',
        confidence: 0.5,
        currentPrice: 0.5,
        reasoning: 'Test message',
        timestamp: new Date(),
      });

      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('notify-send'),
        expect.any(Function)
      );
    });
  });
});