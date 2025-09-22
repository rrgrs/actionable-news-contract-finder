import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ProcessedNews } from './ProcessedNews';

@Entity('processed_contracts')
@Index(['contractId', 'newsId'], { unique: true })
@Index(['contractId'])
export class ProcessedContract {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'contract_id', type: 'text' })
  contractId!: string;

  @Column({ type: 'text' })
  platform!: string;

  @Column({ name: 'news_id', type: 'text' })
  newsId!: string;

  @Column({ name: 'validated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  validatedAt!: Date;

  @Column({ name: 'relevance_score', type: 'real', nullable: true })
  relevanceScore?: number;

  @Column({ type: 'text', nullable: true })
  action?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => ProcessedNews, (news) => news.contracts)
  @JoinColumn({ name: 'news_id', referencedColumnName: 'newsId' })
  processedNews!: ProcessedNews;
}
