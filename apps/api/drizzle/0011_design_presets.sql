CREATE TABLE "design_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"seed_color" text NOT NULL,
	"font_family" text NOT NULL,
	"radius_scale" text NOT NULL,
	"palette" jsonb,
	"color_mode" text DEFAULT 'light' NOT NULL,
	"design_md" text NOT NULL,
	"components" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preset_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_presets" ADD CONSTRAINT "design_presets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preset_assets" ADD CONSTRAINT "preset_assets_preset_id_design_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."design_presets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_presets_owner_idx" ON "design_presets" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "preset_assets_preset_idx" ON "preset_assets" USING btree ("preset_id","created_at");