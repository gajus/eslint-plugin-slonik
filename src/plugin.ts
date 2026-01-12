import { FlatConfig } from "@typescript-eslint/utils/ts-eslint";
import rules from "./rules";
import { version } from "../package.json";

export default {
  rules: rules,
  meta: {
    name: "eslint-plugin-slonik",
    version: version,
  },
} satisfies FlatConfig.Plugin;
