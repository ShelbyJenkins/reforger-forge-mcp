export const PROJECT_PATH_REQUIRED = "PROJECT_PATH_REQUIRED";

export function projectPathRequiredMessage(
  operation: string,
  explicitAlternative?: string
): string {
  const alternative = explicitAlternative
    ? ` or provide ${explicitAlternative}`
    : "";
  return `${PROJECT_PATH_REQUIRED}: ${operation} requires a project path. Supply --project-path, set projectPath in an optional --config file${alternative}.`;
}
