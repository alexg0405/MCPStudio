/** One section of the studio prompt; sections are joined in `order`. */
export interface PromptSection {
  id: string;
  order: number;
  text: string;
}
