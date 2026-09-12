export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_budget_settings: {
        Row: {
          monthly_alert_usd: number | null
          owner_id: string
          warning_percent: number
        }
        Insert: {
          monthly_alert_usd?: number | null
          owner_id?: string
          warning_percent?: number
        }
        Update: {
          monthly_alert_usd?: number | null
          owner_id?: string
          warning_percent?: number
        }
        Relationships: []
      }
      ai_request_usage: {
        Row: {
          book_id: string | null
          cached_input_tokens: number | null
          created_at: string
          error_code: string
          estimated_usd: number | null
          finished_at: string | null
          group_size: number
          id: string
          input_tokens: number | null
          model: string
          operation: string
          output_tokens: number | null
          owner_id: string
          response_id: string | null
          state: string
        }
        Insert: {
          book_id?: string | null
          cached_input_tokens?: number | null
          created_at?: string
          error_code?: string
          estimated_usd?: number | null
          finished_at?: string | null
          group_size?: number
          id?: string
          input_tokens?: number | null
          model: string
          operation: string
          output_tokens?: number | null
          owner_id?: string
          response_id?: string | null
          state?: string
        }
        Update: {
          book_id?: string | null
          cached_input_tokens?: number | null
          created_at?: string
          error_code?: string
          estimated_usd?: number | null
          finished_at?: string | null
          group_size?: number
          id?: string
          input_tokens?: number | null
          model?: string
          operation?: string
          output_tokens?: number | null
          owner_id?: string
          response_id?: string | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: 'ai_request_usage_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      book_translation_previews: {
        Row: {
          applied_at: string | null
          book_id: string
          context: Json
          created_at: string
          id: string
          input_tokens: number
          kind: string
          model: string | null
          output_tokens: number
          owner_id: string
          result: Json
          source_key: string | null
          target_language: string
        }
        Insert: {
          applied_at?: string | null
          book_id: string
          context: Json
          created_at?: string
          id?: string
          input_tokens?: number
          kind: string
          model?: string | null
          output_tokens?: number
          owner_id?: string
          result: Json
          source_key?: string | null
          target_language: string
        }
        Update: {
          applied_at?: string | null
          book_id?: string
          context?: Json
          created_at?: string
          id?: string
          input_tokens?: number
          kind?: string
          model?: string | null
          output_tokens?: number
          owner_id?: string
          result?: Json
          source_key?: string | null
          target_language?: string
        }
        Relationships: [
          {
            foreignKeyName: 'book_translation_previews_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      book_translation_settings: {
        Row: {
          book_id: string
          chat_model: string | null
          context_tokens: number
          glossary_sources: Json
          guide_auto_update: boolean
          guide_chapters_since_update: number
          guide_feedback: string
          guide_interval: number
          main_source_id: string | null
          metadata_source_id: string | null
          owner_id: string
          recent_chapters: number
          reference_book_id: string | null
          reference_mode: string
          reference_source_id: string | null
          revision: number
          target_language: string
          translation_model: string | null
        }
        Insert: {
          book_id: string
          chat_model?: string | null
          context_tokens?: number
          glossary_sources?: Json
          guide_auto_update?: boolean
          guide_chapters_since_update?: number
          guide_feedback?: string
          guide_interval?: number
          main_source_id?: string | null
          metadata_source_id?: string | null
          owner_id?: string
          recent_chapters?: number
          reference_book_id?: string | null
          reference_mode?: string
          reference_source_id?: string | null
          revision?: number
          target_language?: string
          translation_model?: string | null
        }
        Update: {
          book_id?: string
          chat_model?: string | null
          context_tokens?: number
          glossary_sources?: Json
          guide_auto_update?: boolean
          guide_chapters_since_update?: number
          guide_feedback?: string
          guide_interval?: number
          main_source_id?: string | null
          metadata_source_id?: string | null
          owner_id?: string
          recent_chapters?: number
          reference_book_id?: string | null
          reference_mode?: string
          reference_source_id?: string | null
          revision?: number
          target_language?: string
          translation_model?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'book_translation_settings_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: true
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'book_translation_settings_owner_id_reference_book_id_fkey'
            columns: ['owner_id', 'reference_book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'settings_main_source_fk'
            columns: ['owner_id', 'main_source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'settings_metadata_source_fk'
            columns: ['owner_id', 'metadata_source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'settings_reference_source_fk'
            columns: ['owner_id', 'reference_source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      bookmarks: {
        Row: {
          book_id: string
          chapter: number
          created_at: string
          fraction: number
          id: string
          owner_id: string
          title: string
        }
        Insert: {
          book_id: string
          chapter: number
          created_at?: string
          fraction: number
          id?: string
          owner_id?: string
          title: string
        }
        Update: {
          book_id?: string
          chapter?: number
          created_at?: string
          fraction?: number
          id?: string
          owner_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: 'bookmarks_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      books: {
        Row: {
          added_at: string
          author: string
          catalog_metadata: Json
          cover_path: string | null
          description: string
          file_size: number
          folder_id: string | null
          format: string
          genre: string
          id: string
          identification_id: string | null
          import_state: string
          language: string
          novel_id: string
          original_path: string | null
          owner_id: string
          source: string
          source_cover_url: string | null
          source_url: string | null
          title: string
          word_count: number
        }
        Insert: {
          added_at?: string
          author?: string
          catalog_metadata?: Json
          cover_path?: string | null
          description?: string
          file_size: number
          folder_id?: string | null
          format: string
          genre?: string
          id: string
          identification_id?: string | null
          import_state?: string
          language?: string
          novel_id: string
          original_path?: string | null
          owner_id?: string
          source?: string
          source_cover_url?: string | null
          source_url?: string | null
          title: string
          word_count?: number
        }
        Update: {
          added_at?: string
          author?: string
          catalog_metadata?: Json
          cover_path?: string | null
          description?: string
          file_size?: number
          folder_id?: string | null
          format?: string
          genre?: string
          id?: string
          identification_id?: string | null
          import_state?: string
          language?: string
          novel_id?: string
          original_path?: string | null
          owner_id?: string
          source?: string
          source_cover_url?: string | null
          source_url?: string | null
          title?: string
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: 'books_folder_fk'
            columns: ['owner_id', 'folder_id']
            isOneToOne: false
            referencedRelation: 'library_folders'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'books_identification_fk'
            columns: ['owner_id', 'identification_id']
            isOneToOne: false
            referencedRelation: 'page_identifications'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'books_novel_fk'
            columns: ['owner_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'novels'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      chapter_reference_pairs: {
        Row: {
          book_id: string
          owner_id: string
          reference_book_id: string
          reference_position: number
          source_key: string
        }
        Insert: {
          book_id: string
          owner_id?: string
          reference_book_id: string
          reference_position: number
          source_key: string
        }
        Update: {
          book_id?: string
          owner_id?: string
          reference_book_id?: string
          reference_position?: number
          source_key?: string
        }
        Relationships: [
          {
            foreignKeyName: 'chapter_reference_pairs_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'chapter_reference_pairs_owner_id_reference_book_id_referen_fkey'
            columns: ['owner_id', 'reference_book_id', 'reference_position']
            isOneToOne: false
            referencedRelation: 'chapters'
            referencedColumns: ['owner_id', 'book_id', 'position']
          },
        ]
      }
      chapters: {
        Row: {
          book_id: string
          content_path: string
          owner_id: string
          position: number
          title: string
          word_count: number
        }
        Insert: {
          book_id: string
          content_path: string
          owner_id?: string
          position: number
          title: string
          word_count?: number
        }
        Update: {
          book_id?: string
          content_path?: string
          owner_id?: string
          position?: number
          title?: string
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: 'chapters_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      glossary_entries: {
        Row: {
          aliases: string[]
          book_id: string | null
          category: string
          chapter_position: number | null
          created_at: string
          evidence: string
          id: string
          notes: string
          novel_id: string | null
          owner_id: string
          revision: number
          run_id: string | null
          scope: string
          sense: string
          source_language: string
          source_term: string
          status: string
          target_language: string
          target_term: string
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          book_id?: string | null
          category: string
          chapter_position?: number | null
          created_at?: string
          evidence?: string
          id?: string
          notes?: string
          novel_id?: string | null
          owner_id?: string
          revision?: number
          run_id?: string | null
          scope: string
          sense?: string
          source_language?: string
          source_term: string
          status?: string
          target_language?: string
          target_term: string
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          book_id?: string | null
          category?: string
          chapter_position?: number | null
          created_at?: string
          evidence?: string
          id?: string
          notes?: string
          novel_id?: string | null
          owner_id?: string
          revision?: number
          run_id?: string | null
          scope?: string
          sense?: string
          source_language?: string
          source_term?: string
          status?: string
          target_language?: string
          target_term?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'glossary_entries_owner_id_book_id_chapter_position_fkey'
            columns: ['owner_id', 'book_id', 'chapter_position']
            isOneToOne: false
            referencedRelation: 'chapters'
            referencedColumns: ['owner_id', 'book_id', 'position']
          },
          {
            foreignKeyName: 'glossary_entries_owner_id_book_id_novel_id_fkey'
            columns: ['owner_id', 'book_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id', 'novel_id']
          },
          {
            foreignKeyName: 'glossary_entries_owner_id_novel_id_fkey'
            columns: ['owner_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'novels'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'glossary_entries_run_fk'
            columns: ['owner_id', 'run_id']
            isOneToOne: false
            referencedRelation: 'translation_runs'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      library_folders: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
        }
        Relationships: []
      }
      library_settings: {
        Row: {
          owner_id: string
          samples_imported: boolean
          translation_sample_imported: boolean
        }
        Insert: {
          owner_id?: string
          samples_imported?: boolean
          translation_sample_imported?: boolean
        }
        Update: {
          owner_id?: string
          samples_imported?: boolean
          translation_sample_imported?: boolean
        }
        Relationships: []
      }
      novel_sources: {
        Row: {
          book_id: string | null
          contents_data: Json
          created_at: string
          edition_label: string
          id: string
          identification_id: string | null
          label: string
          language: string
          novel_id: string
          original_path: string | null
          owner_id: string
          rights_note: string
          rights_status: string
          role: string
          url: string | null
          url_aliases: Json
          verified_at: string | null
        }
        Insert: {
          book_id?: string | null
          contents_data?: Json
          created_at?: string
          edition_label?: string
          id?: string
          identification_id?: string | null
          label: string
          language: string
          novel_id: string
          original_path?: string | null
          owner_id?: string
          rights_note?: string
          rights_status?: string
          role?: string
          url?: string | null
          url_aliases?: Json
          verified_at?: string | null
        }
        Update: {
          book_id?: string | null
          contents_data?: Json
          created_at?: string
          edition_label?: string
          id?: string
          identification_id?: string | null
          label?: string
          language?: string
          novel_id?: string
          original_path?: string | null
          owner_id?: string
          rights_note?: string
          rights_status?: string
          role?: string
          url?: string | null
          url_aliases?: Json
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'novel_sources_owner_id_book_id_novel_id_fkey'
            columns: ['owner_id', 'book_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id', 'novel_id']
          },
          {
            foreignKeyName: 'novel_sources_owner_id_novel_id_fkey'
            columns: ['owner_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'novels'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'sources_identification_fk'
            columns: ['owner_id', 'identification_id']
            isOneToOne: false
            referencedRelation: 'page_identifications'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      novels: {
        Row: {
          aliases: string[]
          author: string
          created_at: string
          id: string
          original_title: string
          owner_id: string
          style_profile_id: string | null
          title: string
        }
        Insert: {
          aliases?: string[]
          author?: string
          created_at?: string
          id?: string
          original_title?: string
          owner_id?: string
          style_profile_id?: string | null
          title: string
        }
        Update: {
          aliases?: string[]
          author?: string
          created_at?: string
          id?: string
          original_title?: string
          owner_id?: string
          style_profile_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: 'novels_owner_id_style_profile_id_fkey'
            columns: ['owner_id', 'style_profile_id']
            isOneToOne: false
            referencedRelation: 'style_profiles'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      page_identifications: {
        Row: {
          author: string | null
          captured_html_hash: string
          cover_url: string | null
          created_at: string
          id: string
          metadata: Json
          model: string
          output_language: string
          owner_id: string
          prompt_version: string
          raw_extraction: Json
          source_language: string | null
          source_url: string
          title: string | null
          usage: Json
        }
        Insert: {
          author?: string | null
          captured_html_hash: string
          cover_url?: string | null
          created_at?: string
          id?: string
          metadata: Json
          model: string
          output_language: string
          owner_id?: string
          prompt_version: string
          raw_extraction: Json
          source_language?: string | null
          source_url: string
          title?: string | null
          usage?: Json
        }
        Update: {
          author?: string | null
          captured_html_hash?: string
          cover_url?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          model?: string
          output_language?: string
          owner_id?: string
          prompt_version?: string
          raw_extraction?: Json
          source_language?: string | null
          source_url?: string
          title?: string | null
          usage?: Json
        }
        Relationships: []
      }
      reader_chat_turns: {
        Row: {
          answer: string
          book_id: string
          chapter_position: number
          citations: Json
          context: Json
          created_at: string
          error: string
          id: string
          input_tokens: number
          model: string | null
          output_tokens: number
          owner_id: string
          question: string
          scope: string
          source_key: string
          status: string
        }
        Insert: {
          answer?: string
          book_id: string
          chapter_position: number
          citations?: Json
          context?: Json
          created_at?: string
          error?: string
          id: string
          input_tokens?: number
          model?: string | null
          output_tokens?: number
          owner_id?: string
          question: string
          scope: string
          source_key: string
          status?: string
        }
        Update: {
          answer?: string
          book_id?: string
          chapter_position?: number
          citations?: Json
          context?: Json
          created_at?: string
          error?: string
          id?: string
          input_tokens?: number
          model?: string | null
          output_tokens?: number
          owner_id?: string
          question?: string
          scope?: string
          source_key?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: 'reader_chat_turns_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      reader_search_chunks: {
        Row: {
          chunk_index: number
          document_id: string
          end_offset: number
          owner_id: string
          start_offset: number
          terms: unknown
        }
        Insert: {
          chunk_index: number
          document_id: string
          end_offset: number
          owner_id?: string
          start_offset: number
          terms: unknown
        }
        Update: {
          chunk_index?: number
          document_id?: string
          end_offset?: number
          owner_id?: string
          start_offset?: number
          terms?: unknown
        }
        Relationships: [
          {
            foreignKeyName: 'reader_search_chunks_owner_id_document_id_fkey'
            columns: ['owner_id', 'document_id']
            isOneToOne: false
            referencedRelation: 'reader_search_documents'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      reader_search_documents: {
        Row: {
          book_id: string
          chapter_position: number
          chunk_count: number
          content_hash: string
          id: string
          owner_id: string
          search_bytes: number
          source_id: string | null
          source_key: string
          title: string
          updated_at: string
          variant: string
          version_id: string | null
        }
        Insert: {
          book_id: string
          chapter_position: number
          chunk_count?: number
          content_hash: string
          id?: string
          owner_id?: string
          search_bytes?: number
          source_id?: string | null
          source_key: string
          title: string
          updated_at?: string
          variant: string
          version_id?: string | null
        }
        Update: {
          book_id?: string
          chapter_position?: number
          chunk_count?: number
          content_hash?: string
          id?: string
          owner_id?: string
          search_bytes?: number
          source_id?: string | null
          source_key?: string
          title?: string
          updated_at?: string
          variant?: string
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'reader_search_documents_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'reader_search_documents_owner_id_source_id_fkey'
            columns: ['owner_id', 'source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'reader_search_documents_owner_id_version_id_fkey'
            columns: ['owner_id', 'version_id']
            isOneToOne: false
            referencedRelation: 'book_translation_previews'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      reading_progress: {
        Row: {
          book_id: string
          chapter: number
          fraction: number
          last_read_at: string | null
          owner_id: string
          source_chapter_url: string | null
          source_id: string | null
          status: string
          target_language: string | null
          translation_version: string | null
        }
        Insert: {
          book_id: string
          chapter?: number
          fraction?: number
          last_read_at?: string | null
          owner_id?: string
          source_chapter_url?: string | null
          source_id?: string | null
          status?: string
          target_language?: string | null
          translation_version?: string | null
        }
        Update: {
          book_id?: string
          chapter?: number
          fraction?: number
          last_read_at?: string | null
          owner_id?: string
          source_chapter_url?: string | null
          source_id?: string | null
          status?: string
          target_language?: string | null
          translation_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'reading_progress_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: true
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'reading_progress_source_fk'
            columns: ['owner_id', 'source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'reading_progress_translation_fk'
            columns: ['owner_id', 'translation_version']
            isOneToOne: false
            referencedRelation: 'book_translation_previews'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      site_navigation: {
        Row: {
          origin: string
          owner_id: string
          recipes: Json
          validated_at: string
        }
        Insert: {
          origin: string
          owner_id?: string
          recipes?: Json
          validated_at?: string
        }
        Update: {
          origin?: string
          owner_id?: string
          recipes?: Json
          validated_at?: string
        }
        Relationships: []
      }
      site_scrapers: {
        Row: {
          code: string
          code_hash: string
          contract_version: string
          origin: string
          owner_id: string
          page_kind: string
          report_id: string
          validated_at: string
        }
        Insert: {
          code: string
          code_hash: string
          contract_version: string
          origin: string
          owner_id?: string
          page_kind: string
          report_id: string
          validated_at?: string
        }
        Update: {
          code?: string
          code_hash?: string
          contract_version?: string
          origin?: string
          owner_id?: string
          page_kind?: string
          report_id?: string
          validated_at?: string
        }
        Relationships: []
      }
      source_analysis_runs: {
        Row: {
          book_id: string
          context: Json
          created_at: string
          id: string
          input_tokens: number
          model: string
          output_tokens: number
          owner_id: string
          reference_source_id: string
          result: Json
          source_id: string
          source_url: string
        }
        Insert: {
          book_id: string
          context: Json
          created_at?: string
          id?: string
          input_tokens?: number
          model: string
          output_tokens?: number
          owner_id?: string
          reference_source_id: string
          result: Json
          source_id: string
          source_url: string
        }
        Update: {
          book_id?: string
          context?: Json
          created_at?: string
          id?: string
          input_tokens?: number
          model?: string
          output_tokens?: number
          owner_id?: string
          reference_source_id?: string
          result?: Json
          source_id?: string
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: 'source_analysis_runs_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'source_analysis_runs_owner_id_reference_source_id_fkey'
            columns: ['owner_id', 'reference_source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'source_analysis_runs_owner_id_source_id_source_url_fkey'
            columns: ['owner_id', 'source_id', 'source_url']
            isOneToOne: false
            referencedRelation: 'source_chapters'
            referencedColumns: ['owner_id', 'source_id', 'url']
          },
        ]
      }
      source_chapter_alignments: {
        Row: {
          method: string
          owner_id: string
          reason: string
          reference_source_id: string
          reference_urls: string[]
          source_id: string
          source_url: string
          status: string
          updated_at: string
        }
        Insert: {
          method: string
          owner_id?: string
          reason?: string
          reference_source_id: string
          reference_urls?: string[]
          source_id: string
          source_url: string
          status: string
          updated_at?: string
        }
        Update: {
          method?: string
          owner_id?: string
          reason?: string
          reference_source_id?: string
          reference_urls?: string[]
          source_id?: string
          source_url?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'source_chapter_alignments_owner_id_reference_source_id_fkey'
            columns: ['owner_id', 'reference_source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'source_chapter_alignments_owner_id_source_id_source_url_fkey'
            columns: ['owner_id', 'source_id', 'source_url']
            isOneToOne: false
            referencedRelation: 'source_chapters'
            referencedColumns: ['owner_id', 'source_id', 'url']
          },
        ]
      }
      source_chapters: {
        Row: {
          content_hash: string
          content_path: string
          downloaded_at: string
          id: string
          owner_id: string
          provenance: Json
          source_id: string
          title: string
          url: string
          word_count: number
        }
        Insert: {
          content_hash: string
          content_path: string
          downloaded_at?: string
          id?: string
          owner_id?: string
          provenance?: Json
          source_id: string
          title: string
          url: string
          word_count: number
        }
        Update: {
          content_hash?: string
          content_path?: string
          downloaded_at?: string
          id?: string
          owner_id?: string
          provenance?: Json
          source_id?: string
          title?: string
          url?: string
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: 'source_chapters_owner_id_source_id_fkey'
            columns: ['owner_id', 'source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      source_reading_progress: {
        Row: {
          chapter_url: string
          fraction: number
          owner_id: string
          source_id: string
          updated_at: string
        }
        Insert: {
          chapter_url: string
          fraction?: number
          owner_id?: string
          source_id: string
          updated_at?: string
        }
        Update: {
          chapter_url?: string
          fraction?: number
          owner_id?: string
          source_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'source_reading_progress_owner_id_source_id_fkey'
            columns: ['owner_id', 'source_id']
            isOneToOne: true
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      source_translation_progress: {
        Row: {
          chapter_url: string
          fraction: number
          owner_id: string
          source_id: string
          target_language: string
          translation_version: string | null
          updated_at: string
        }
        Insert: {
          chapter_url: string
          fraction: number
          owner_id?: string
          source_id: string
          target_language: string
          translation_version?: string | null
          updated_at?: string
        }
        Update: {
          chapter_url?: string
          fraction?: number
          owner_id?: string
          source_id?: string
          target_language?: string
          translation_version?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'source_translation_progress_owner_id_source_id_fkey'
            columns: ['owner_id', 'source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'source_translation_progress_owner_id_translation_version_fkey'
            columns: ['owner_id', 'translation_version']
            isOneToOne: false
            referencedRelation: 'book_translation_previews'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      style_examples: {
        Row: {
          book_id: string
          character_count: number
          content_hash: string
          content_path: string
          created_at: string
          file_name: string
          id: string
          novel_id: string
          owner_id: string
        }
        Insert: {
          book_id: string
          character_count: number
          content_hash: string
          content_path: string
          created_at?: string
          file_name: string
          id?: string
          novel_id: string
          owner_id?: string
        }
        Update: {
          book_id?: string
          character_count?: number
          content_hash?: string
          content_path?: string
          created_at?: string
          file_name?: string
          id?: string
          novel_id?: string
          owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'style_examples_owner_id_book_id_novel_id_fkey'
            columns: ['owner_id', 'book_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id', 'novel_id']
          },
        ]
      }
      style_profiles: {
        Row: {
          id: string
          inference: Json | null
          instructions: string
          name: string
          owner_id: string
          updated_at: string
          version: number
        }
        Insert: {
          id?: string
          inference?: Json | null
          instructions?: string
          name: string
          owner_id?: string
          updated_at?: string
          version?: number
        }
        Update: {
          id?: string
          inference?: Json | null
          instructions?: string
          name?: string
          owner_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      translation_batch_chapters: {
        Row: {
          attempts: number
          batch_id: string
          completed_at: string | null
          content_hash: string | null
          error: string
          owner_id: string
          position: number
          preview_id: string | null
          source_key: string
          started_at: string | null
          state: string
          title: string
        }
        Insert: {
          attempts?: number
          batch_id: string
          completed_at?: string | null
          content_hash?: string | null
          error?: string
          owner_id?: string
          position: number
          preview_id?: string | null
          source_key: string
          started_at?: string | null
          state?: string
          title: string
        }
        Update: {
          attempts?: number
          batch_id?: string
          completed_at?: string | null
          content_hash?: string | null
          error?: string
          owner_id?: string
          position?: number
          preview_id?: string | null
          source_key?: string
          started_at?: string | null
          state?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: 'translation_batch_chapters_owner_id_batch_id_fkey'
            columns: ['owner_id', 'batch_id']
            isOneToOne: false
            referencedRelation: 'translation_batches'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'translation_batch_chapters_owner_id_preview_id_fkey'
            columns: ['owner_id', 'preview_id']
            isOneToOne: false
            referencedRelation: 'book_translation_previews'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      translation_batches: {
        Row: {
          all_untranslated: boolean
          book_id: string
          chapters_per_request: number
          created_at: string
          error: string
          estimate: Json
          id: string
          last_error_code: string
          lease_expires_at: string | null
          max_attempts: number
          model: string
          owner_id: string
          range_end: number
          range_start: number
          request_kind: string
          resume_automatically: boolean
          retranslate: boolean
          retry_at: string | null
          settings_revision: number
          source_id: string | null
          state: string
          target_language: string
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          all_untranslated?: boolean
          book_id: string
          chapters_per_request?: number
          created_at?: string
          error?: string
          estimate?: Json
          id: string
          last_error_code?: string
          lease_expires_at?: string | null
          max_attempts?: number
          model: string
          owner_id?: string
          range_end: number
          range_start: number
          request_kind?: string
          resume_automatically?: boolean
          retranslate?: boolean
          retry_at?: string | null
          settings_revision: number
          source_id?: string | null
          state?: string
          target_language: string
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          all_untranslated?: boolean
          book_id?: string
          chapters_per_request?: number
          created_at?: string
          error?: string
          estimate?: Json
          id?: string
          last_error_code?: string
          lease_expires_at?: string | null
          max_attempts?: number
          model?: string
          owner_id?: string
          range_end?: number
          range_start?: number
          request_kind?: string
          resume_automatically?: boolean
          retranslate?: boolean
          retry_at?: string | null
          settings_revision?: number
          source_id?: string | null
          state?: string
          target_language?: string
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'translation_batches_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
          {
            foreignKeyName: 'translation_batches_owner_id_source_id_fkey'
            columns: ['owner_id', 'source_id']
            isOneToOne: false
            referencedRelation: 'novel_sources'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
      translation_runs: {
        Row: {
          book_id: string
          chapter_position: number
          completed_at: string | null
          context_snapshot: Json
          created_at: string
          error_message: string | null
          id: string
          input_hash: string
          input_tokens: number | null
          kind: string
          mode: string
          model: string
          novel_id: string
          output_tokens: number | null
          owner_id: string
          prompt_version: string
          result: Json | null
          status: string
        }
        Insert: {
          book_id: string
          chapter_position: number
          completed_at?: string | null
          context_snapshot?: Json
          created_at?: string
          error_message?: string | null
          id?: string
          input_hash: string
          input_tokens?: number | null
          kind: string
          mode: string
          model: string
          novel_id: string
          output_tokens?: number | null
          owner_id?: string
          prompt_version: string
          result?: Json | null
          status?: string
        }
        Update: {
          book_id?: string
          chapter_position?: number
          completed_at?: string | null
          context_snapshot?: Json
          created_at?: string
          error_message?: string | null
          id?: string
          input_hash?: string
          input_tokens?: number | null
          kind?: string
          mode?: string
          model?: string
          novel_id?: string
          output_tokens?: number | null
          owner_id?: string
          prompt_version?: string
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: 'translation_runs_owner_id_book_id_chapter_position_fkey'
            columns: ['owner_id', 'book_id', 'chapter_position']
            isOneToOne: false
            referencedRelation: 'chapters'
            referencedColumns: ['owner_id', 'book_id', 'position']
          },
          {
            foreignKeyName: 'translation_runs_owner_id_book_id_novel_id_fkey'
            columns: ['owner_id', 'book_id', 'novel_id']
            isOneToOne: false
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id', 'novel_id']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_identified_novel: {
        Args: {
          contents_data: Json
          identification: string
          overwrite_existing?: boolean
          reference_sources: Json
          reviewed_author: string
          reviewed_title: string
        }
        Returns: Json
      }
      add_source_book: {
        Args: {
          contents_data: Json
          identification: string
          novel_updates_url?: string
          overwrite_existing?: boolean
          reference_sources: Json
          reviewed_author: string
          reviewed_title: string
        }
        Returns: Json
      }
      ai_usage_overview: { Args: { month_start: string }; Returns: Json }
      apply_book_metadata: { Args: { preview_id: string }; Returns: undefined }
      apply_identification_metadata: {
        Args: { identification: string; target_novel: string }
        Returns: undefined
      }
      attach_novelupdates: {
        Args: { catalog_url: string; target_book: string }
        Returns: string
      }
      canonical_source_contents: {
        Args: { aliases: Json; contents: Json }
        Returns: Json
      }
      claim_translation_batch: {
        Args: {
          retry_failed?: boolean
          target_batch: string
          worker_key: string
        }
        Returns: undefined
      }
      claim_translation_batch_chapter: {
        Args: { target_batch: string; worker_key: string }
        Returns: {
          attempts: number
          batch_id: string
          completed_at: string | null
          content_hash: string | null
          error: string
          owner_id: string
          position: number
          preview_id: string | null
          source_key: string
          started_at: string | null
          state: string
          title: string
        }[]
        SetofOptions: {
          from: '*'
          to: 'translation_batch_chapters'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_translation_batch_group: {
        Args: {
          maximum_chapters: number
          target_batch: string
          worker_key: string
        }
        Returns: {
          attempts: number
          batch_id: string
          completed_at: string | null
          content_hash: string | null
          error: string
          owner_id: string
          position: number
          preview_id: string | null
          source_key: string
          started_at: string | null
          state: string
          title: string
        }[]
        SetofOptions: {
          from: '*'
          to: 'translation_batch_chapters'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      complete_batch_translation: {
        Args: {
          chapter_position: number
          consumed_input: number
          consumed_output: number
          draft: Json
          snapshot: Json
          target_batch: string
          worker_key: string
        }
        Returns: Json
      }
      complete_chapter_translation: {
        Args: {
          chapter_key: string
          consumed_input: number
          consumed_output: number
          draft: Json
          expected_revision: number
          snapshot: Json
          target_book: string
          translation_model: string
        }
        Returns: Json
      }
      complete_source_analysis: {
        Args: {
          analysis: Json
          analysis_model: string
          chapter_url: string
          consumed_input: number
          consumed_output: number
          expected_revision: number
          reference_source: string
          snapshot: Json
          target_book: string
          target_source: string
        }
        Returns: string
      }
      complete_term_extraction: {
        Args: {
          consumed_input: number
          consumed_output: number
          extraction_id: string
          extraction_result: Json
        }
        Returns: undefined
      }
      configure_private_library: {
        Args: { allowed_user: string }
        Returns: undefined
      }
      control_translation_batch: {
        Args: { command: string; target_batch: string }
        Returns: undefined
      }
      create_grouped_translation_batch: {
        Args: {
          chosen_model: string
          cost_estimate: Json
          expected_revision: number
          maximum_group_size: number
          range_end: number
          range_start: number
          request_id: string
          target_book: string
        }
        Returns: string
      }
      create_inferred_style: {
        Args: {
          example_ids: string[]
          expected_profile: string
          style_instructions: string
          style_metadata: Json
          target_book: string
        }
        Returns: string
      }
      create_reader_translation_batch: {
        Args: {
          chapter_position: number
          chosen_model: string
          cost_estimate: Json
          expected_revision: number
          new_version: boolean
          request_id: string
          target_book: string
        }
        Returns: string
      }
      create_translation_batch: {
        Args: {
          chosen_model: string
          cost_estimate: Json
          expected_revision: number
          range_end: number
          range_start: number
          request_id: string
          target_book: string
        }
        Returns: string
      }
      create_untranslated_translation_batch: {
        Args: {
          chapter_count: number
          chosen_model: string
          cost_estimate: Json
          expected_revision: number
          maximum_group_size: number
          request_id: string
          target_book: string
        }
        Returns: string
      }
      defer_translation_group_chapters: {
        Args: {
          chapter_positions: number[]
          target_batch: string
          worker_key: string
        }
        Returns: undefined
      }
      fail_translation_batch: {
        Args: {
          failure_message: string
          target_batch: string
          worker_key: string
        }
        Returns: undefined
      }
      index_reader_document: {
        Args: {
          chapter_index: number
          chapter_key: string
          chapter_title: string
          chunks: Json
          fingerprint: string
          reading_source: string
          target_book: string
          translation_version: string
          variant_key: string
        }
        Returns: string
      }
      library_access_status: { Args: never; Returns: Json }
      list_library_glossaries: {
        Args: never
        Returns: {
          book_id: string
          categories: string[]
          source_language: string
          target_language: string
          term_count: number
          title: string
        }[]
      }
      materialize_source_book: {
        Args: { target_source: string }
        Returns: string
      }
      pair_identified_edition: {
        Args: {
          identification: string
          reviewed_label: string
          reviewed_language: string
          source_role: string
          target_book: string
        }
        Returns: Json
      }
      private_library_allowed: { Args: never; Returns: boolean }
      record_source_chapter_alias: {
        Args: {
          canonical_url: string
          requested_url: string
          target_source: string
        }
        Returns: undefined
      }
      remove_novel_source: {
        Args: { target_book: string; target_source: string }
        Returns: string[]
      }
      renew_translation_batch_lease: {
        Args: { target_batch: string; worker_key: string }
        Returns: boolean
      }
      review_source_alignment: {
        Args: {
          chapter_url: string
          decision: string
          paired_urls: string[]
          reference_source: string
          target_source: string
        }
        Returns: undefined
      }
      save_continuation_style: {
        Args: {
          expected_profile: string
          expected_revision: number
          reference_source: string
          style_instructions: string
          style_metadata: Json
          target_book: string
        }
        Returns: string
      }
      save_source_contents: {
        Args: { contents: Json; source_url: string; target_book: string }
        Returns: boolean
      }
      save_source_reading_position: {
        Args: {
          chapter_url: string
          finished?: boolean
          fraction: number
          language?: string
          observed_at?: string
          target_source: string
          version_id?: string
        }
        Returns: undefined
      }
      save_translation_term_edit: {
        Args: {
          edited_result: Json
          preferred_aliases: string[]
          preferred_category: string
          preferred_scope: string
          preferred_sense: string
          preferred_target: string
          preview_id: string
          previous_target: string
          source_spelling: string
        }
        Returns: string
      }
      schedule_translation_retry: {
        Args: {
          failure_code: string
          failure_message: string
          retry_delay_seconds: number
          target_batch: string
          worker_key: string
        }
        Returns: boolean
      }
      search_reader_passages: {
        Args: { document_ids: string[]; query_terms: string[] }
        Returns: {
          chunk_index: number
          document_id: string
          end_offset: number
          rank: number
          start_offset: number
        }[]
      }
      set_book_translation_settings: {
        Args: {
          expected_revision: number
          main_source: string
          metadata_source: string
          reference_book: string
          reference_mode: string
          target_book: string
          target_language: string
        }
        Returns: undefined
      }
      set_chapter_reference_pair: {
        Args: {
          chapter_key: string
          expected_revision: number
          positions: number[]
          reference_book: string
          target_book: string
        }
        Returns: undefined
      }
      set_context_preferences: {
        Args: {
          auto_guide: boolean
          expected_revision: number
          feedback: string
          recent_count: number
          target_book: string
          token_budget: number
          update_interval: number
        }
        Returns: undefined
      }
      set_glossary_sources: {
        Args: {
          expected_revision: number
          selected_sources: Json
          target_book: string
        }
        Returns: undefined
      }
      set_reader_models: {
        Args: {
          chat_choice?: string
          expected_revision: number
          target_book: string
          translation_choice?: string
        }
        Returns: undefined
      }
      set_source_translation_settings: {
        Args: {
          expected_revision: number
          main_source: string
          metadata_source: string
          reference_book: string
          reference_mode: string
          reference_source: string
          target_book: string
          target_language: string
        }
        Returns: undefined
      }
      skip_batch_translation: {
        Args: {
          chapter_position: number
          saved_preview: string
          target_batch: string
          worker_key: string
        }
        Returns: undefined
      }
      translation_chapter_busy: {
        Args: { chapter_key: string; target_batch: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
