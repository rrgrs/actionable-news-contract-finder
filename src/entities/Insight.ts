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

@Entity('insights')
@Index(['newsId'])
export class Insight {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'news_id', type: 'text' })
  newsId!: string;

  @Column({ name: 'insight_data', type: 'text' })
  insightData!: string;

  @Column({ name: 'relevance_score', type: 'real', nullable: true })
  relevanceScore?: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => ProcessedNews, (news) => news.insights)
  @JoinColumn({ name: 'news_id', referencedColumnName: 'newsId' })
  processedNews!: ProcessedNews;
}
