export type Result<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

export function success<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

export function failure<Failure>(error: Failure): Result<never, Failure> {
  return { ok: false, error };
}

export function mapResult<Value, Next, Failure>(
  result: Result<Value, Failure>,
  map: (value: Value) => Next
): Result<Next, Failure> {
  return result.ok ? success(map(result.value)) : result;
}
