BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES
('portfolio-resumes','portfolio-resumes',false,10485760,ARRAY['application/pdf']),
('portfolio-knowledge','portfolio-knowledge',false,20971520,ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
('portfolio-images','portfolio-images',true,4194304,ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- Client writes are not granted; the authenticated backend uploads using its server-only secret key.
COMMIT;
