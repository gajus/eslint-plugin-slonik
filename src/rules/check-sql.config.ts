import { RuleContext } from "./check-sql.rule";
import { Config } from "./RuleOptions";

export function getConfigFromFileWithContext(params: {
  context: RuleContext;
  projectDir: string;
}): Config {
  return params.context.options[0];
}
