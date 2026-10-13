// Creates apps/api/.env and apps/web/.env from their examples if they don't
// exist yet (never overwrites), then says what still needs filling in.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

for (const dir of ['apps/api', 'apps/web']) {
	if (existsSync(`${dir}/.env`)) {
		console.log(`${dir}/.env already exists, leaving it as is`);
	} else {
		copyFileSync(`${dir}/.env.example`, `${dir}/.env`);
		console.log(`Created ${dir}/.env from .env.example`);
	}
}

const env = readFileSync('apps/api/.env', 'utf8');
const groqKey = env
	.match(/^GROQ_API_KEY=(.*)$/m)?.[1]
	?.replace(/["']/g, '')
	.trim();
const usesOllama = /^DEFAULT_MODEL_PROVIDER=["']?ollama/m.test(env);
if (!groqKey && !usesOllama) {
	console.log(
		'\nThe agent needs a model: put a free key from https://console.groq.com/keys in\n' +
			'GROQ_API_KEY in apps/api/.env (or set up Ollama, see the README).',
	);
}
