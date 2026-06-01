# Raven 测试数据

> 用途：写作批改、阅读精读、听力练习、生词导入等功能的测试数据

---

## 一、写作批改测试文本

### 1.1 混合错误（综合测试）

**测试文本 A**（基础水平，含 5 类错误）：
```
Yesterday I go to the library and borrowed two book. The librarian was very helpful, she recommanded me a interesting novel about the history of ancient Rome. I thinked it would be a good read for my english class. Me and my friend plan to discuss it next week.
```

预期错误类别：时态错误、单复数、拼写错误、冠词错误、主谓一致

**测试文本 B**（中等水平，含 7 类错误）：
```
Despite of the heavy rain, the students was still arrived on time for the exam. The teacher which organized the event said that everyone have to submit their paper before 5pm. She don't want anyone to be late because it would effect the whole schedule. Between you and I, the test was much more easier than we expected.
```

预期错误类别：介词错误、主谓一致、时态错误、用词不当、冠词错误、语序错误

**测试文本 C**（高级水平，含复杂句式错误）：
```
Not only the company increased its revenue, but also they expanded to three new markets. Had I knew about the deadline, I would submitted the proposal earlier. The reason why he failed the interview is because he didn't prepare enough. Each of the students have their own opinion about the project, and neither the professor or the teaching assistant agree with the final decision.
```

预期错误类别：语序错误、时态错误、句式杂糅、主谓一致

---

### 1.2 按错误类别分类

#### 时态错误

1. `Yesterday I go to the supermarket and buy some groceries.`
2. `She work at this company since 2019.`
3. `By the time we arrive, the movie already started.`
4. `I am living in Beijing for five years now.`
5. `He told me that he will come tomorrow.`

#### 主谓一致

1. `The team of scientists are working on a new project.`
2. `Everyone have their own opinion about this matter.`
3. `Neither the teacher nor the students was prepared for the test.`
4. `The news are very disappointing today.`
5. `Each of the boys have completed their homework.`

#### 冠词错误

1. `She is student at the local university.`
2. `I need to buy a umbrella because it's raining.`
3. `He played piano at the concert last night.`
4. `Can you pass me salt?`
5. `She is most intelligent person I have ever met.`

#### 单复数

1. `I have three childs and two dog.`
2. `The informations you provided are very helpful.`
3. `She bought two book and three pencil yesterday.`
4. `There are many sheeps on the hill.`
5. `His advices helped me a lot during the difficult time.`

#### 用词不当

1. `I am very boring in this class.`
2. `He said me to come early tomorrow.`
3. `I am agree with your opinion.`
4. `She suggested me to apply for the job.`
5. `The price of this house is very expensive.`

#### 拼写错误

1. `I recieved your email yesterday and was very greatful.`
2. `The goverment announced new enviromental policies.`
3. `She is a very indepedent and ambitous person.`
4. `We need to find a definete solution to this problem.`
5. `His performence in the exam was exellent.`

#### 介词错误

1. `I arrived to the airport at 6am.`
2. `She is married with a doctor.`
3. `I am looking forward to hear from you.`
4. `He is afraid with dogs.`
5. `We discussed about the problem for hours.`

#### 句式杂糅

1. `The reason why he left is because he was unhappy.`
2. `I want that you come to my party.`
3. `Despite of the rain, we went hiking.`
4. `The fact that he is rich doesn't means that he is happy.`
5. `Although he tried hard, but he still failed.`

#### 标点错误

1. `I like apples, oranges and, bananas.`
2. `She said "I will come tomorrow.`
3. `Its a beautiful day, isn't it?`
4. `However, the results, were not as expected.`
5. `He asked, that whether we could leave early.`

#### 缺少成分

1. `When arrived at the station.`
2. `The book on the table is interesting, but the one on the shelf not.`
3. `She is taller than me.`
4. `If possible, I would like to go.`
5. `Running in the park every morning.`

#### 语序错误

1. `Never I have seen such a beautiful sunset.`
2. `She can hardly not believe the news.`
3. `Only after the exam he realized his mistake.`
4. `Not only he is smart, but also hardworking.`
5. `So beautiful the scenery was that we stopped to take photos.`

---

### 1.3 无错误文本（验证不误报）

**测试文本 D**（正确文本，不应有纠错）：
```
The rapid development of artificial intelligence has transformed many industries in recent years. Companies around the world are investing heavily in AI research and development, hoping to gain a competitive advantage. However, this technological revolution also raises important ethical questions about privacy, employment, and the future of human creativity.
```

**测试文本 E**（正确文本，复杂句式）：
```
Had it not been for the generous donation from local businesses, the community center would have been forced to close its doors. Not only did the funding save the center, but it also enabled the expansion of several programs that serve underprivileged youth in the area.
```

---

## 二、阅读精读测试文本

### 2.1 科技类文章

```
Artificial intelligence has made remarkable strides in natural language processing. Modern language models can generate human-like text, translate between languages, and even write code. However, these models still struggle with understanding context and nuance, often producing plausible-sounding but factually incorrect responses. Researchers are working on ways to make AI systems more reliable and transparent, including techniques like chain-of-thought prompting and retrieval-augmented generation.
```

### 2.2 经济类文章

```
The global economy faces a complex set of challenges in 2024. Inflation rates, while declining from their peaks, remain above central bank targets in many developed countries. The labor market continues to show surprising resilience, with unemployment rates near historic lows in several major economies. Meanwhile, geopolitical tensions and supply chain disruptions pose ongoing risks to economic stability. Central banks must carefully balance the need to control inflation against the risk of triggering a recession through overly aggressive monetary tightening.
```

### 2.3 文学类文章

```
In his seminal work "1984," George Orwell painted a chilling portrait of a totalitarian society where individual thought is suppressed and history is constantly rewritten to serve the interests of the ruling party. The novel's protagonist, Winston Smith, works at the Ministry of Truth, where his job is to alter historical records to match the party's ever-changing version of reality. Through Winston's journey, Orwell explores themes of surveillance, propaganda, and the fragility of truth in the face of absolute power.
```

### 2.4 短文本（边界测试）

```
The cat sat on the mat.
```

### 2.5 非英文文本（语言检测测试）

```
今天天气很好，我想去公园散步。人工智能的发展给很多行业带来了变革。
```

---

## 三、听力练习测试数据

### 3.1 初级句子

1. `The weather is nice today.`
2. `I like to read books in the morning.`
3. `She goes to school by bus.`
4. `We had dinner at a restaurant last night.`
5. `He is playing football with his friends.`

### 3.2 中级句子

1. `Despite the heavy traffic, we managed to arrive at the airport on time.`
2. `The experiment yielded unexpected results that challenged existing theories.`
3. `She has been working on this project for over three months now.`
4. `If I had known about the meeting earlier, I would have prepared a presentation.`
5. `The company's decision to expand into Asian markets proved to be highly profitable.`

### 3.3 高级句子

1. `Notwithstanding the considerable obstacles encountered during the implementation phase, the team successfully delivered the project ahead of schedule.`
2. `The juxtaposition of traditional values and modern aspirations creates a unique cultural dynamic in rapidly developing societies.`
3. `Had the government implemented the recommended reforms earlier, the economic downturn might have been significantly mitigated.`
4. `The proliferation of misinformation on social media platforms has necessitated the development of sophisticated fact-checking algorithms.`
5. `The symposium's keynote speaker articulated a compelling argument for the integration of interdisciplinary approaches in addressing climate change.`

---

## 四、生词本导入测试数据

### 4.1 CSV 格式（标准）

```csv
word,phonetic,definition,level
abandon,əˈbændən,放弃；抛弃,CET-4
elaborate,ɪˈlæbərət,精心制作的；详尽的,CET-6
ambiguous,æmˈbɪɡjuəs,模棱两可的,CET-6
resilient,rɪˈzɪliənt,有弹性的；恢复力强的,TEM-4
ubiquitous,juːˈbɪkwɪtəs,无处不在的,TEM-8
```

### 4.2 CSV 格式（无表头，Tab 分隔）

```
ephemeral	ɪˈfemərəl	短暂的	TEM-8
pragmatic	præɡˈmætɪk	务实的	CET-6
paradigm	ˈpærədaɪm	范式	TEM-4
juxtapose	ˌdʒʌkstəˈpoʊz	并列	TEM-8
eloquent	ˈeləkwənt	雄辩的	CET-6
```

### 4.3 CSV 格式（含空字段，需自动补全）

```csv
word,phonetic,definition,level
serendipity,,,CET-6
quintessential,,,
ephemeral,ɪˈfemərəl,短暂的,
,,
solitude,sɒlɪtjuːd,独处,CET-4
```

### 4.4 CSV 格式（含重复词）

```csv
word,phonetic,definition,level
abandon,əˈbændən,放弃;抛弃,CET-4
resilient,rɪˈzɪliənt,有弹性的,TEM-4
abandon,,,CET-6
serendipity,,,CET-6
resilient,,恢复力强的,TEM-8
```

### 4.5 空文件

```
```

### 4.6 仅表头

```csv
word,phonetic,definition,level
```

---

## 五、弱项训练测试数据

### 5.1 预期题型映射验证

| 错误类别 | 预期题型 | 测试说明 |
|----------|----------|----------|
| 时态错误 | fill | 4 选 1 填空 |
| 主谓一致 | fill | 4 选 1 填空 |
| 单复数 | fill | 4 选 1 填空 |
| 冠词错误 | correct | 输入改正后的句子 |
| 介词错误 | correct | 输入改正后的句子 |
| 用词不当 | rewrite | 用正确方式重写句子 |
| 句式杂糅 | rewrite | 用正确方式重写句子 |
| 拼写错误 | rewrite | 用正确方式重写句子 |
| 标点错误 | rewrite | 用正确方式重写句子 |
| 缺少成分 | rewrite | 用正确方式重写句子 |
| 语序错误 | rewrite | 用正确方式重写句子 |

### 5.2 填空题答案匹配测试

| 用户答案 | 正确答案 | 预期结果 |
|----------|----------|----------|
| went | went | ✅ 正确 |
| Went | went | ✅ 正确（不区分大小写） |
| went | gone | ❌ 错误 |
| a book | a book | ✅ 正确 |
| a book | A book | ✅ 正确 |

### 5.3 改错/重写题答案匹配测试

| 用户答案 | 正确答案 | 预期结果 |
|----------|----------|----------|
| He is a student | He is a student | ✅ 正确 |
| He  is  a  student | He is a student | ✅ 正确（归一化空格） |
| He is student | He is a student | ❌ 错误 |

---

## 六、API 连接测试数据

### 6.1 OpenAI 配置

```
名称：OpenAI GPT-4o-mini
API 地址：https://api.openai.com/v1
模型名称：gpt-4o-mini
API 密钥：sk-...（用户自己的 key）
```

### 6.2 DeepSeek 配置

```
名称：DeepSeek Chat
API 地址：https://api.deepseek.com/v1
模型名称：deepseek-chat
API 密钥：sk-...（用户自己的 key）
```

### 6.3 Ollama 本地配置

```
名称：Ollama Local
API 地址：http://localhost:11434/v1
模型名称：llama3
API 密钥：ollama
```

### 6.4 无效配置（测试错误处理）

```
名称：Invalid
API 地址：https://invalid.api.com/v1
模型名称：gpt-4o-mini
API 密钥：sk-invalid-key
```

---

## 七、学习目标测试数据

### 7.1 预设配置验证

| 预设 | 复习 | 练习 | 阅读 | 写作 | 听力 |
|------|------|------|------|------|------|
| 轻松 | 5 | 1 | 1 | 1 | 1 |
| 标准 | 10 | 2 | 1 | 1 | 1 |
| 进阶 | 20 | 3 | 2 | 2 | 2 |

### 7.2 自定义目标

```
复习：15
练习：3
阅读：2
写作：2
听力：2
```

---

## 八、间隔复习测试数据

### 8.1 算法验证用例

| 初始状态 | 评分 | 预期间隔 | 预期状态 |
|----------|------|----------|----------|
| new, count=0 | 认识 | 2 天 | learning, count=1 |
| learning, count=1 | 认识 | 4 天 | learning, count=2 |
| learning, count=2 | 认识 | 8 天 | learning, count=3 |
| learning, count=3 | 认识 | 16 天 | mastered |
| learning, interval=8 | 不认识 | 1 天 | learning, count=0 |
| learning, interval=8 | 模糊 | 8 天 | learning, count+1 |
| learning, interval=16 | 认识 | 30 天（上限） | learning, count+1 |

### 8.2 测试词汇集

```
abandon, ephemeral, pragmatic, resilient, ubiquitous
serendipity, quintessential, paradigm, juxtapose, eloquent
```
