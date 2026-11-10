import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
type Expression = { permission: string } | { allOf: Expression[] } | { anyOf: Expression[] };
const contract = parse(readFileSync(new URL('../../../identity/policies.yaml', import.meta.url), 'utf8')) as {
  spec: { entry: { permission: string }; operations: Record<string, Expression> };
};
export const identityServiceAccess = (environment: string): string => {
  const permission = contract.spec.entry.permission.replace('{environment}', environment);
  if (permission !== `admin-web:${environment}:access`)
    throw new Error('Invalid Admin API entry policy.');
  return permission;
};
export const hasIdentityOperationPolicy = (
  roles: readonly string[],
  operation: string,
  environment = 'staging',
): boolean => {
  const evaluate = (expression: Expression | undefined): boolean => {
    if (!expression) return false;
    if ('permission' in expression)
      return roles.includes(expression.permission.replaceAll('{environment}', environment));
    if ('allOf' in expression)
      return expression.allOf.length > 0 && expression.allOf.every(evaluate);
    return expression.anyOf.length > 0 && expression.anyOf.some(evaluate);
  };
  return evaluate(contract.spec.operations[operation.replaceAll(':', '.')]);
};
