import json
import urllib.request
import urllib.parse
import time

# Load existing words
with open('dictionary.json', 'r', encoding='utf-8') as f:
    words_data = json.load(f)

# Take the first 5000 words to process (to avoid making too many requests and getting blocked)
words_to_process = [item['word'] for item in words_data[:5000]]
rich_dictionary = []

batch_size = 50
for i in range(0, len(words_to_process), batch_size):
    batch = words_to_process[i:i+batch_size]
    titles = "|".join(batch)
    
    # Use generic Wikipedia API to get the extract/summary
    # We use ko.wiktionary.org for dictionary style definitions
    url = f'https://ko.wiktionary.org/w/api.php?action=query&prop=extracts&titles={urllib.parse.quote(titles)}&exintro=1&explaintext=1&format=json'
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Bot)'})
        res = urllib.request.urlopen(req).read().decode('utf-8')
        data = json.loads(res)
        
        pages = data.get('query', {}).get('pages', {})
        for page_id, p_info in pages.items():
            title = p_info.get('title')
            # Extract contains the wiktionary definition, clean it up
            extract = p_info.get('extract', '').strip()
            
            # Wiktionary extracts sometimes include multiple lines, we just take the first meaningful line
            if title and extract and '명사' not in extract: # ensure it's not a dummy blank
                # take first line
                first_line = extract.split('\n')[0][:100]
                if first_line and len(first_line) > 5:
                    rich_dictionary.append({
                        'word': title,
                        'meaning': first_line
                    })
    except Exception as e:
        print(f"Batch failed: {e}")
        pass
        
    time.sleep(0.1) # Be polite to the API

print(f"Successfully grabbed {len(rich_dictionary)} real meanings!")

# Save back to dictionary.json
if len(rich_dictionary) > 0:
    with open('dictionary.json', 'w', encoding='utf-8') as f:
        json.dump(rich_dictionary, f, ensure_ascii=False, indent=1)
