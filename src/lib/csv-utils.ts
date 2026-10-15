/**
 * CSV 文本解析工具。
 *
 * 处理批量导入场景中的 CSV/TXT 文本行，支持 RFC 4180 标准的引号字段。
 */

/**
 * 解析单行 CSV 文本，支持 RFC 4180 标准的引号字段。
 *
 * 处理规则：
 * - 字段用双引号包裹时，内部逗号不作为分隔符（如 `"hello, world",definition`）
 * - 引号内的双引号用 `""` 转义（如 `"She said ""hi"""`）
 * - 自动检测分隔符：如果行内包含 Tab 则用 Tab 分割，否则用逗号
 * - 未加引号的字段自动 trim；引号字段内容原样保留（含前后空白）——
 *   RFC 4180 中引号内的空白是数据的一部分，trim 会破坏其语义
 *
 * @param line - 单行 CSV/TXT 文本
 * @returns 分割后的字段数组
 */
export function parseCsvLine(line: string): string[] {
  // Tab 分隔检测：仅当行内不含引号（引号字段内部可能出现 Tab）且 Tab 数
  // 不少于逗号时才按 Tab 分割；否则走引号感知的逗号解析，
  // 避免含 Tab 的引号字段被错位拆分（原实现任意位置有 Tab 即整体按 Tab 分割）。
  // 该分支已要求行内无引号，不存在"引号内空白需保留"的语义，trim 是安全的
  const tabCount = (line.match(/\t/g) ?? []).length;
  const commaCount = (line.match(/,/g) ?? []).length;
  if (tabCount > 0 && !line.includes('"') && tabCount >= commaCount) {
    return line.split("\t").map((s) => s.trim());
  }

  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  // 当前字段是否被引号包裹过：引号内内容（含前后空白）是 RFC 4180 意义上的
  // 数据，必须原样保留；只有未加引号的字段才 trim（旧实现对所有字段 trim）
  let quoted = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // 检查是否是转义引号（""）
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          // 引号结束
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        quoted = true;
        i++;
      } else if (ch === ",") {
        fields.push(quoted ? current : current.trim());
        current = "";
        quoted = false;
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  // 最后一个字段
  fields.push(quoted ? current : current.trim());

  return fields;
}
