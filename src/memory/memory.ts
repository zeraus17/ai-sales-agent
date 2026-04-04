const memory: Record<string, any> = {};

export function saveMemory(thread_id: string, data: any) {
  memory[thread_id] = data;
}

export function getMemory(thread_id: string) {
  return memory[thread_id];
}