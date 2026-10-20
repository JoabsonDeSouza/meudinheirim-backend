export function shouldEnableSwaggerUi(
  isProduction: boolean,
  username: string | undefined,
  password: string | undefined,
): boolean {
  return !isProduction || (username !== undefined && password !== undefined);
}
