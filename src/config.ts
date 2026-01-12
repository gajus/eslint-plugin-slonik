import { FlatConfig } from "@typescript-eslint/utils/ts-eslint";
import { Config } from "./rules/RuleOptions";
import slonikPlugin from "./plugin";

export default {
  configs: {
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
