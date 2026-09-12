import type { Database } from '../supabase/database.types.ts'

type Tables = Database['public']['Tables']
export type Novel = Tables['novels']['Row']
export type NovelSource = Tables['novel_sources']['Row']
export type GlossaryEntry = Tables['glossary_entries']['Row']
export type StyleProfile = Tables['style_profiles']['Row']
export type StyleExample = Tables['style_examples']['Row']
export type TranslationRun = Tables['translation_runs']['Row']
export type BookTranslationSettings = Tables['book_translation_settings']['Row']
export type ChapterReferencePair = Tables['chapter_reference_pairs']['Row']
export type TranslationPreview = Tables['book_translation_previews']['Row']
