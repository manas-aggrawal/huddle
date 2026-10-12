import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { SearchService } from './search.service';

@Module({
	providers: [SearchService, ScraperService],
	exports: [SearchService, ScraperService],
})
export class ResearchModule {}
