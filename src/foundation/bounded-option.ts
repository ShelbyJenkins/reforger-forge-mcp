export interface BoundedOptionFailure {
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  message: string;
}

export type BoundedOptionErrorFactory = (failure: BoundedOptionFailure) => Error;

const defaultError: BoundedOptionErrorFactory = ({ message }) => new RangeError(message);

/** Select a default and require one safe integer within the inclusive bounds. */
export function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  errorFactory: BoundedOptionErrorFactory = defaultError
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    const message = `${label} must be an integer from ${minimum} through ${maximum}`;
    throw errorFactory({ value: selected, minimum, maximum, label, message });
  }
  return selected;
}
