import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { Insight } from './Insight';
import { ProcessedContract } from './ProcessedContract';

@Entity('processed_news')
@Index(['newsId'], { unique: true })
@Index(['processedAt'])
export class ProcessedNews {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'news_id', type: 'text', unique: true })
  newsId!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  source!: string;

  @Column({ type: 'text', nullable: true })
  url?: string;

  @Column({ name: 'processed_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  processedAt!: Date;

  @Column({ name: 'insight_generated', type: 'boolean', default: false })
  insightGenerated!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @OneToMany(() => Insight, (insight) => insight.processedNews)
  insights!: Insight[];

  @OneToMany(() => ProcessedContract, (contract) => contract.processedNews)
  contracts!: ProcessedContract[];
}
