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
          cover_path: string | null
          description: string
          file_size: number
          format: string
          genre: string
          id: string
          import_state: string
          language: string
          original_path: string
          owner_id: string
          source: string
          source_url: string | null
          title: string
          word_count: number
        }
        Insert: {
          added_at?: string
          author?: string
          cover_path?: string | null
          description?: string
          file_size: number
          format: string
          genre?: string
          id: string
          import_state?: string
          language?: string
          original_path: string
          owner_id?: string
          source?: string
          source_url?: string | null
          title: string
          word_count?: number
        }
        Update: {
          added_at?: string
          author?: string
          cover_path?: string | null
          description?: string
          file_size?: number
          format?: string
          genre?: string
          id?: string
          import_state?: string
          language?: string
          original_path?: string
          owner_id?: string
          source?: string
          source_url?: string | null
          title?: string
          word_count?: number
        }
        Relationships: []
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
      library_settings: {
        Row: {
          owner_id: string
          samples_imported: boolean
        }
        Insert: {
          owner_id?: string
          samples_imported?: boolean
        }
        Update: {
          owner_id?: string
          samples_imported?: boolean
        }
        Relationships: []
      }
      reading_progress: {
        Row: {
          book_id: string
          chapter: number
          fraction: number
          last_read_at: string | null
          owner_id: string
          status: string
        }
        Insert: {
          book_id: string
          chapter?: number
          fraction?: number
          last_read_at?: string | null
          owner_id?: string
          status?: string
        }
        Update: {
          book_id?: string
          chapter?: number
          fraction?: number
          last_read_at?: string | null
          owner_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: 'reading_progress_owner_id_book_id_fkey'
            columns: ['owner_id', 'book_id']
            isOneToOne: true
            referencedRelation: 'books'
            referencedColumns: ['owner_id', 'id']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
