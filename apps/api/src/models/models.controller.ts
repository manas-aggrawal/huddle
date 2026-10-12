import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { allowedModels } from './models.registry';

const ModelOptionSchema = z.object({
	provider: z.string(),
	modelId: z.string(),
	label: z.string(),
	isDefault: z.boolean(),
});
class ModelOptionDto extends createZodDto(ModelOptionSchema) {}

@ApiTags('Sessions')
@ApiBearerAuth('access-token')
@Controller('models')
export class ModelsController {
	/** Models a new session can use, the default first. */
	@Get()
	@ZodResponse({ status: 200, type: [ModelOptionDto] })
	list(): ModelOptionDto[] {
		return allowedModels();
	}
}
