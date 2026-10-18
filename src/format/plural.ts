/** "1 change", "2 changes". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
