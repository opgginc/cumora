/** Strings for the docs section (keys `docs.*`). */
export const en = {
  'docs.title': 'Documents', 'docs.subtitle': 'Shared notes, edited together.', 'docs.new': 'New document',
  'docs.search': 'Search documents', 'docs.sort': 'Sort', 'docs.sortUpdated': 'Recently edited', 'docs.sortTitle': 'Title',
  'docs.loading': 'Loading documents', 'docs.noMatches': 'No matching documents', 'docs.empty': 'No documents yet',
  'docs.createFirst': 'Create a document', 'docs.untitled': 'Untitled', 'docs.edited': 'Edited', 'docs.delete': 'Delete document',
  'docs.deleteConfirm': 'Delete “{title}”? This cannot be undone.', 'docs.back': 'Back to documents', 'docs.editor': 'Document', 'docs.retry': 'Retry',
} as const
export const zhCN: Partial<Record<keyof typeof en, string>> = {
  'docs.title': '文档', 'docs.subtitle': '共同编辑的共享笔记。', 'docs.new': '新建文档', 'docs.search': '搜索文档', 'docs.sort': '排序',
  'docs.sortUpdated': '最近编辑', 'docs.sortTitle': '标题', 'docs.loading': '正在加载文档', 'docs.noMatches': '没有匹配的文档',
  'docs.empty': '暂无文档', 'docs.createFirst': '创建文档', 'docs.untitled': '未命名', 'docs.edited': '编辑于', 'docs.delete': '删除文档',
  'docs.deleteConfirm': '确定删除“{title}”吗？此操作无法撤销。', 'docs.back': '返回文档列表', 'docs.editor': '文档', 'docs.retry': '重试',
}
export const ko: Record<keyof typeof en, string> = {
  'docs.title': '문서', 'docs.subtitle': '함께 편집하는 공유 노트예요.', 'docs.new': '새 문서', 'docs.search': '문서 검색', 'docs.sort': '정렬',
  'docs.sortUpdated': '최근 편집순', 'docs.sortTitle': '제목순', 'docs.loading': '문서를 불러오는 중', 'docs.noMatches': '일치하는 문서가 없어요',
  'docs.empty': '아직 문서가 없어요', 'docs.createFirst': '문서 만들기', 'docs.untitled': '제목 없음', 'docs.edited': '마지막 편집', 'docs.delete': '문서 삭제',
  'docs.deleteConfirm': '“{title}” 문서를 삭제할까요? 되돌릴 수 없어요.', 'docs.back': '문서 목록', 'docs.editor': '문서', 'docs.retry': '다시 시도',
}
