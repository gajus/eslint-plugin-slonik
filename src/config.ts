import { FlatConfig } from "@typescript-eslint/utils/ts-eslint";
import { Config } from "./rules/RuleOptions";
import slonikPlugin from "./plugin";

export default {
  configs: {
    /**
     * If you prefer configuring via a config file (slonik.config.ts), use this config.
     */
    useConfigFile: {
      plugins: {
        slonik: slonikPlugin,
      },
      rules: {
        "slonik/check-sql": ["error", { useConfigFile: true }],
      },
    } satisfies FlatConfig.Config,

    /**
     * If you prefer configuring via a flat config, use this config.
     */
    connections: (connections: Config["connections"]): FlatConfig.Config => ({
      plugins: {
        slonik: slonikPlugin,
      },
      rules: {
        "slonik/check-sql": ["error", { connections }],
      },
    }),
  },
};
