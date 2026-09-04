import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			// Set just under what the suite actually reaches, so a change that
			// drops coverage fails here rather than being noticed later. They
			// were only a gate once CI started running `test:coverage` at all.
			thresholds: {
				lines: 94,
				statements: 92,
				branches: 85,
				functions: 98,
			},
		},
	},
});
