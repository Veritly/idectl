export function sample(input: number) {
  let value = input * 2
  const proof = value + 1 // idectl-breakpoint
  return proof
}

console.log(sample(21))
