/**
 * Minimal type declarations for `epub-gen` (0.1.x, no bundled types).
 * Only the surface used by epub-service.ts is declared.
 *
 * @author Liang.Xu
 */
declare module 'epub-gen' {
  export interface EpubContent {
    title: string;
    data: string;
    beforeToc?: boolean;
    excludeFromToc?: boolean;
  }

  export interface EpubOptions {
    title: string;
    author?: string | string[];
    publisher?: string;
    cover?: string;
    version?: 2 | 3;
    css?: string;
    lang?: string;
    /** 章节（HTML 片段）；epub-gen 0.1.x 亦接受 string，但标准用法为数组 */
    content?: EpubContent[];
    /** 在每章正文前自动插入 <h1>章节标题</h1>（默认 true） */
    appendChapterTitles?: boolean;
    verbose?: boolean;
    [key: string]: unknown;
  }

  export class Epub {
    constructor(options: EpubOptions, output?: string);
    promise: Promise<string>;
    save(options?: EpubOptions, output?: string): Promise<string>;
  }

  export default Epub;
}
