import http.server
import socketserver
import os
import json
from urllib.parse import urlparse, parse_qs

PORT = 8080
DIRECTORY = "F:\\Mockups"

class MockupHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_GET(self):
        parsed_url = urlparse(self.path)
        
        # Получить список папок
        if parsed_url.path == '/api/folders':
            try:
                folders = [d for d in os.listdir(DIRECTORY) if os.path.isdir(os.path.join(DIRECTORY, d))]
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(folders).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
            return
            
        # Получить список PNG (превью) внутри конкретной папки
        if parsed_url.path == '/api/files':
            query_params = parse_qs(parsed_url.query)
            folder = query_params.get('folder', [''])[0]
            folder_path = os.path.join(DIRECTORY, folder)
            
            if os.path.isdir(folder_path):
                files = []
                for f in os.listdir(folder_path):
                    if f.endswith('.png'):
                        psd_name = f.replace('.png', '.psd')
                        # Добавляем в список только если существует PSD файл с таким же именем
                        if os.path.exists(os.path.join(folder_path, psd_name)):
                            files.append(f)
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(files).encode('utf-8'))
            else:
                self.send_response(404)
                self.end_headers()
            return
            
        # Скачать сам PSD файл (скрыто от пользователя)
        if parsed_url.path == '/download':
            query_params = parse_qs(parsed_url.query)
            folder = query_params.get('folder', [''])[0]
            file = query_params.get('file', [''])[0]
            psd_path = os.path.join(DIRECTORY, folder, file.replace('.png', '.psd'))
            
            if os.path.exists(psd_path):
                with open(psd_path, 'rb') as f:
                    self.send_response(200)
                    self.send_header('Content-type', 'application/octet-stream')
                    self.end_headers()
                    self.wfile.write(f.read())
            else:
                self.send_response(404)
                self.end_headers()
            return

        # Обычная раздача файлов (для отображения PNG превью в интерфейсе)
        super().do_GET()

if __name__ == "__main__":
    if not os.path.exists(DIRECTORY):
        os.makedirs(DIRECTORY)
    with socketserver.TCPServer(("", PORT), MockupHandler) as httpd:
        print(f"Сервер мокапов запущен на http://127.0.0.1:{PORT}")
        print(f"Папка с мокапами: {DIRECTORY}")
        httpd.serve_forever()