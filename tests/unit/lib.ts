// 单测公用：linkedom 序列化时属性顺序不保证与写入顺序一致（setAttribute 的新属性可能排在前面），
// 断言整段 HTML 时先把每个起始标签里的属性按名字排序，只比语义不比顺序
export const norm = (html: string): string =>
  html.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_m, tag: string, attrs: string, slash: string) => {
    const list = (attrs.match(/[^\s=]+(?:="[^"]*")?/g) ?? []).sort();
    return `<${tag}${list.length ? ' ' + list.join(' ') : ''}${slash}>`;
  });
