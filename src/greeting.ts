/**
 * 问候功能模块
 * 提供中文问候回复功能
 */

/**
 * 获取中文问候回复
 * @returns 友好的中文问候语
 */
export function getChineseGreeting(): string {
  return "你好，有什么可以帮助你的吗？";
}

/**
 * 根据时间获取适当的问候语
 * @returns 根据当前时间的中文问候语
 */
export function getTimeBasedGreeting(): string {
  const hour = new Date().getHours();
  
  if (hour >= 5 && hour < 12) {
    return "早上好！有什么可以帮助你的吗？";
  } else if (hour >= 12 && hour < 18) {
    return "下午好！有什么可以帮助你的吗？";
  } else if (hour >= 18 && hour < 22) {
    return "晚上好！有什么可以帮助你的吗？";
  } else {
    return "你好！有什么可以帮助你的吗？";
  }
}

/**
 * 获取完整的问候响应
 * @param includeTimeBased 是否包含基于时间的问候
 * @returns 问候响应字符串
 */
export function getGreetingResponse(includeTimeBased: boolean = false): string {
  if (includeTimeBased) {
    return getTimeBasedGreeting();
  }
  return getChineseGreeting();
}